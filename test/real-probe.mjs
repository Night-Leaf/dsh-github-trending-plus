#!/usr/bin/env node
// Task-10 real-network probe.
//
// This script deliberately imports only `getReport()` from the built plugin
// (`lib/report.js`). It never opens a socket itself: every request goes through
// the plugin's own transport chain and network configuration, so a probe run
// exercises the same code path that a real panel load will use.
//
// Usage:
//   node test/real-probe.mjs                  # run the 3-attempt probe
//   node test/real-probe.mjs --apply continue # user verdict -> user-continue
//   node test/real-probe.mjs --apply retry
//   node test/real-probe.mjs --apply abort
//
// The script always exits 0: a network failure is data recorded in the JSON,
// not a script failure.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getReport } from '../lib/report.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const EVIDENCE_PATH = resolve(REPO_ROOT, 'test/out/real-probe.json')

const ATTEMPT_COUNT = 3
const INTERVAL_MS = 2000

// Single board, small slice, no enrichment / README traffic: the 50-row run
// that also enriches is covered by the post-install first real load.
const REPORT_OPTIONS = Object.freeze({
  since: 'daily',
  limit: 15,
  focusCount: 1,
  enrichCount: 0,
  readmeCount: 0,
  refresh: true,
})

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

/** Flatten an error and its `cause` chain into one lowercase search string. */
function errorText(error) {
  const parts = []
  let current = error
  for (let depth = 0; current && depth < 6; depth += 1) {
    parts.push(
      String(current.name ?? ''),
      String(current.message ?? current),
      String(current.code ?? ''),
      String(current.errno ?? ''),
    )
    current = current.cause
  }
  return parts.join(' | ').toLowerCase()
}

/** Map a thrown error onto dns / tls / timeout / http / parse / unknown. */
export function classifyError(error) {
  if (!error) return ''
  const text = errorText(error)
  if (/enotfound|eai_again|getaddrinfo|name_not_resolved|doh resolution failed|\bdns\b/.test(text)) return 'dns'
  if (/certificate|\bcert\b|\btls\b|\bssl\b|self.signed|unable_to_verify|handshake/.test(text)) return 'tls'
  if (/timeout|timedout|etimedout|aborted|\babort\b|und_err_abort/.test(text)) return 'timeout'
  if (/http \d{3}|\bhttp\b|status code/.test(text)) return 'http'
  if (/parse|parsed|json|unexpected token|syntaxerror/.test(text)) return 'parse'
  return 'unknown'
}

function attemptRecord(index, startedAt, result) {
  return {
    index,
    startedAt,
    ms: result.ms,
    status: result.status,
    repoCount: result.repoCount,
    reposLength: result.reposLength,
    shortfall: result.shortfall,
    shortfallReason: result.shortfallReason,
    enrichedCount: result.enrichedCount,
    apiCalls: result.apiCalls,
    networkStatus: result.networkStatus,
    lastVia: result.lastVia,
    errorClass: result.errorClass,
    errorMessage: result.errorMessage,
  }
}

async function runAttempt(index) {
  const startedAt = new Date().toISOString()
  const started = Date.now()
  try {
    const report = await getReport({ ...REPORT_OPTIONS })
    const repos = Array.isArray(report?.repos) ? report.repos : []
    return attemptRecord(index, startedAt, {
      ms: Date.now() - started,
      status: 'ok',
      repoCount: repos.length,
      reposLength: repos.length,
      shortfall: report?.shortfall ?? null,
      shortfallReason: report?.shortfallReason ?? null,
      enrichedCount: report?.enrichedCount ?? 0,
      apiCalls: report?.apiCalls ?? 0,
      networkStatus: report?.networkStatus ?? 'fail',
      lastVia: String(report?.lastVia ?? ''),
      errorClass: '',
      errorMessage: null,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return attemptRecord(index, startedAt, {
      ms: Date.now() - started,
      status: 'error',
      repoCount: 0,
      reposLength: 0,
      shortfall: null,
      shortfallReason: null,
      enrichedCount: 0,
      apiCalls: 0,
      networkStatus: 'fail',
      lastVia: '',
      errorClass: classifyError(error),
      errorMessage: message,
    })
  }
}

function isSuccess(attempt) {
  return attempt.repoCount >= 1 && !attempt.errorClass
}

export function gateFor(attempts) {
  const successes = attempts.filter(isSuccess).length
  if (successes >= 2) return 'pass'
  if (successes === 1) return 'degraded'
  return 'blocked'
}

export function networkVerifiedFor(attempts) {
  return attempts.some((attempt) => attempt.repoCount > 0 && String(attempt.lastVia ?? '').trim() !== '')
}

function noteFor(gate, attempts) {
  const successes = attempts.filter(isSuccess).length
  const details = attempts
    .map((a) => `#${a.index}:${a.repoCount}/${a.lastVia || '-'}/${a.errorClass || 'ok'}`)
    .join(', ')
  if (gate === 'pass') {
    return `网络可用：3 次探针中 ${successes} 次成功（${details}），gate=pass，无需用户裁决。`
  }
  if (gate === 'degraded') {
    return `网络不稳定：3 次探针中仅 ${successes} 次成功（${details}），gate=degraded，等待用户裁决。`
  }
  return `网络不稳定：3 次探针全部失败（${details}），gate=blocked，等待用户裁决。`
}

/**
 * User verdict on degraded/blocked evidence: writes the decision onto the
 * evidence object itself and returns it. Only 'continue' is defined by the
 * plan; 'retry' / 'abort' are recorded as the matching user-* verdicts.
 */
export function applyDecision(evidence, action) {
  if (action === 'continue') evidence.decision = 'user-continue'
  else if (action === 'retry') evidence.decision = 'user-retry'
  else if (action === 'abort') evidence.decision = 'user-abort'
  else throw new Error(`unknown decision action: ${action}`)
  return evidence
}

function writeEvidence(evidence) {
  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true })
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
}

export async function runProbe() {
  const attempts = []
  for (let index = 1; index <= ATTEMPT_COUNT; index += 1) {
    const attempt = await runAttempt(index)
    attempts.push(attempt)
    process.stdout.write(
      `attempt ${index}/${ATTEMPT_COUNT}: status=${attempt.status} repoCount=${attempt.repoCount} ` +
        `lastVia=${attempt.lastVia || '-'} errorClass=${attempt.errorClass || '-'} ms=${attempt.ms}\n`,
    )
    if (index < ATTEMPT_COUNT) await sleep(INTERVAL_MS)
  }

  const gate = gateFor(attempts)
  const evidence = {
    attempts,
    gate,
    networkLayerVerified: networkVerifiedFor(attempts),
    note: noteFor(gate, attempts),
  }
  if (gate !== 'pass') evidence.decision = 'pending-user'

  writeEvidence(evidence)
  process.stdout.write(`gate=${gate} networkLayerVerified=${evidence.networkLayerVerified}\n`)
  process.stdout.write(`evidence: ${EVIDENCE_PATH}\n`)
  return evidence
}

function main() {
  const applyIndex = process.argv.indexOf('--apply')
  if (applyIndex >= 0) {
    const action = process.argv[applyIndex + 1] ?? ''
    const evidence = JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8'))
    const updated = applyDecision(evidence, action)
    writeEvidence(updated)
    process.stdout.write(`decision=${updated.decision}\n`)
    process.stdout.write(`evidence: ${EVIDENCE_PATH}\n`)
    return
  }
  void REPO_ROOT
  runProbe().catch((error) => {
    // The probe treats network errors as data; a crash here is still recorded
    // so the caller can see it instead of an empty file, and the exit code
    // stays 0 by contract.
    process.stdout.write(`probe crashed: ${error instanceof Error ? error.message : String(error)}\n`)
  })
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
