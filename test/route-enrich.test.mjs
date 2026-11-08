#!/usr/bin/env node
/**
 * Offline test for the host `/report` route's `enrich` mapping (Task-1).
 *
 * Mounts the plugin against a fake Cordis context (the same shape as
 * `test/smoke-host-offline.mjs`) and calls the route handler directly, with a
 * fetch stub that serves the Trending board and the GitHub API from memory.
 * Nothing leaves this machine.
 *
 * Asserted:
 *   - `enrich=0` → `enrichedCount === 0`, and the snapshot does not overwrite
 *     the recent-report entry a full report left in `RECENT_REPORTS`;
 *   - `enrich=1` → `enrichedCount > 0`;
 *   - no `enrich` (default) → `enrichedCount > 0`.
 *
 * Usage: node test/route-enrich.test.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(here, '..')

// Deterministic offline run: no ambient key/token file may make the report or
// the AI config look configured. Set before importing the host entry.
delete process.env.DSH_GITHUB_TRENDING_AI_KEY
delete process.env.DEEPSEEK_API_KEY
delete process.env.GITHUB_TOKEN
delete process.env.GH_TOKEN
process.env.DSH_GITHUB_TRENDING_AI_KEY_FILE = path.join(here, 'fixtures', '__no_such_key_file__')
process.env.GITHUB_TOKEN_FILE = path.join(here, 'fixtures', '__no_such_token_file__')

const BOARD_HTML = `<!doctype html>
<html lang="en">
<body>
  <main>
    <article class="Box-row">
      <h2><a href="/acme/alpha">acme / alpha</a></h2>
      <p class="col-9">First offline fixture project</p>
      <span itemprop="programmingLanguage">TypeScript</span>
      <a href="/acme/alpha/stargazers">1,200</a>
      <a href="/acme/alpha/forks">80</a>
      <span>120 stars today</span>
    </article>
    <article class="Box-row">
      <h2><a href="/beta/bravo">beta / bravo</a></h2>
      <p class="col-9">Second offline fixture project</p>
      <span itemprop="programmingLanguage">Go</span>
      <a href="/beta/bravo/stargazers">900</a>
      <a href="/beta/bravo/forks">60</a>
      <span>90 stars today</span>
    </article>
    <article class="Box-row">
      <h2><a href="/gamma/charlie">gamma / charlie</a></h2>
      <p class="col-9">Third offline fixture project</p>
      <span itemprop="programmingLanguage">Rust</span>
      <a href="/gamma/charlie/stargazers">700</a>
      <a href="/gamma/charlie/forks">40</a>
      <span>70 stars today</span>
    </article>
  </main>
</body>
</html>
`

const networkHosts = []
const realFetch = globalThis.fetch

function textResponse(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

function repoPayload(fullName) {
  return {
    full_name: fullName,
    topics: ['trending', 'offline-fixture'],
    license: { spdx_id: 'MIT' },
    archived: false,
    created_at: '2024-01-01T00:00:00Z',
    pushed_at: '2026-11-01T00:00:00Z',
    open_issues_count: 3,
    homepage: '',
    default_branch: 'main',
  }
}

// Every request must be answered here; an unexpected host is a test failure,
// never a real network call.
globalThis.fetch = async (input) => {
  const raw = typeof input === 'string' ? input : String(input && input.url ? input.url : '')
  const url = new URL(raw)
  networkHosts.push(url.hostname)
  if (url.hostname === 'github.com' && url.pathname === '/trending') return textResponse(BOARD_HTML)
  if (url.hostname === 'api.github.com') {
    const repo = /^\/repos\/([^/]+\/[^/]+)$/.exec(url.pathname)
    if (repo) return jsonResponse(repoPayload(repo[1]))
    // `/repos/{full_name}/readme` falls through: no README for the fixtures.
    return textResponse('not found', 404)
  }
  if (url.hostname === 'raw.githubusercontent.com') return textResponse('not found', 404)
  throw new Error(`route-enrich.test.mjs must not reach ${url.hostname}`)
}

// --- fake Cordis host ------------------------------------------------------
const registered = { tools: [], commands: [], routes: [] }
const routes = new Map()

const webServer = {
  register(route) {
    registered.routes.push(route)
    routes.set(route.path, route)
    return () => {
      registered.routes = registered.routes.filter((item) => item !== route)
      routes.delete(route.path)
    }
  },
}

const ctx = {
  tools: {
    register(definition) {
      registered.tools.push(definition)
      return () => {
        registered.tools = registered.tools.filter((item) => item !== definition)
      }
    },
  },
  effect(setup) {
    setup()
  },
  inject(_deps, callback) {
    callback(ctx)
  },
  get(name) {
    if (name === 'webServer') return webServer
    return undefined
  },
  logger: {
    info() {},
    warn() {},
  },
}

const host = await import(pathToFileURL(path.resolve(rootDir, 'index.js')).href)
const { apply, rememberReportForTest, recentReportForTest } = host

// Forced direct: the transport chain is exactly `direct`, so the fetch stub
// above is the only route out. Also skips egress discovery (registry / ports).
apply(ctx, { forceDirect: true })

const reportRoute = routes.get('/dsh-github-trending/report')
if (!reportRoute || typeof reportRoute.handler !== 'function') {
  console.error('FAIL route-enrich: /dsh-github-trending/report was not mounted')
  process.exit(1)
}

function captureResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value
    },
    end(body) {
      this.body = body === undefined || body === null ? '' : String(body)
    },
  }
}

async function requestReport(query) {
  const search = new URLSearchParams(query).toString()
  const req = {
    method: 'GET',
    url: `/dsh-github-trending/report${search ? `?${search}` : ''}`,
    headers: { host: '127.0.0.1:3080' },
  }
  const res = captureResponse()
  await reportRoute.handler(req, res)
  let body
  try {
    body = JSON.parse(res.body)
  } catch {
    body = { raw: res.body }
  }
  return { status: res.statusCode, body }
}

const failures = []

async function run(name, fn) {
  try {
    await fn()
    console.log(`PASS route-enrich: ${name}`)
  } catch (error) {
    failures.push(name)
    console.log(`FAIL route-enrich: ${name}`)
    console.log(String((error && error.stack) || error).replace(/^/gm, '  '))
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

// --- case 1: enrich=0 ------------------------------------------------------
// Seed a full report under the exact recent-report key the snapshot will use.
// The snapshot must leave it untouched.
const SEED_MARKER = 'seed-full-report-marker'
rememberReportForTest(
  {
    since: 'daily',
    language: null,
    limit: 3,
    focusCount: 3,
    enrichedCount: 7,
    generatedAt: SEED_MARKER,
    repos: [],
  },
  3,
)

await run('enrich=0 → snapshot (enrichedCount=0, recent report untouched)', async () => {
  const result = await requestReport({ since: 'daily', limit: '3', focus: '3', enrich: '0' })
  assert(result.status === 200, `status is ${result.status}`)
  assert(result.body.repos && result.body.repos.length === 3, `repos=${result.body.repos && result.body.repos.length}`)
  assert(result.body.enrichedCount === 0, `enrichedCount=${result.body.enrichedCount}, expected 0`)
  const seeded = recentReportForTest('daily', '', 3)
  assert(seeded, 'a full report should still occupy the recent-report slot')
  assert(seeded.generatedAt === SEED_MARKER, `recent report was overwritten by the snapshot (generatedAt=${seeded.generatedAt})`)
  assert(seeded.enrichedCount === 7, `recent report enrichedCount=${seeded.enrichedCount}, expected the seed's 7`)
})

// --- case 2: enrich=1 ------------------------------------------------------
await run('enrich=1 → full tier (enrichedCount>0)', async () => {
  const result = await requestReport({ since: 'weekly', limit: '3', focus: '3', enrich: '1' })
  assert(result.status === 200, `status is ${result.status}`)
  assert(result.body.repos && result.body.repos.length === 3, `repos=${result.body.repos && result.body.repos.length}`)
  assert(result.body.enrichedCount > 0, `enrichedCount=${result.body.enrichedCount}, expected > 0`)
  const remembered = recentReportForTest('weekly', '', 3)
  assert(remembered, 'the full tier should be remembered for translate/AI reuse')
  assert(remembered.generatedAt === result.body.generatedAt, 'the remembered report is not the one the route returned')
})

// --- case 3: no enrich (default) ------------------------------------------
await run('no enrich → full tier (enrichedCount>0)', async () => {
  const result = await requestReport({ since: 'monthly', limit: '3', focus: '3' })
  assert(result.status === 200, `status is ${result.status}`)
  assert(result.body.repos && result.body.repos.length === 3, `repos=${result.body.repos && result.body.repos.length}`)
  assert(result.body.enrichedCount > 0, `enrichedCount=${result.body.enrichedCount}, expected > 0`)
})

if (networkHosts.some((hostname) => !['github.com', 'api.github.com', 'raw.githubusercontent.com'].includes(hostname))) {
  failures.push('unexpected network host')
  console.log(`FAIL route-enrich: unexpected network host(s): ${networkHosts.join(', ')}`)
}

// The stub is the only fetch in this process; make sure the module did not
// capture and use the real one.
if (globalThis.fetch !== realFetch && networkHosts.length === 0) {
  failures.push('no fetch stub call')
  console.log('FAIL route-enrich: the stub was never called')
}

if (failures.length > 0) {
  console.log(`FAIL route-enrich: ${failures.length} case(s) failed`)
  process.exitCode = 1
} else {
  console.log('ok')
}
