/**
 * Optional enrichment through the public GitHub REST API.
 *
 * Trending HTML only carries stars / forks / language / description. Topics,
 * licence, age, issue pressure and a README excerpt make the analysis much more
 * substantive, but the unauthenticated API is limited to 60 requests per hour —
 * so every call is cached, bounded by a deadline, and every failure degrades to
 * "no enrichment" instead of failing the report.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { fetchText } from './http.js'
import type { TrendingRepo } from './trending.js'
import { cleanText, noteFetchVia } from './trending.js'

export interface RepoFacts {
  fullName: string
  enriched: boolean
  topics: string[]
  license: string | null
  archived: boolean
  createdAt: string | null
  pushedAt: string | null
  openIssues: number | null
  homepage: string | null
  readmeSnippet: string | null
  /** True when the README that was found is Chinese, by file name or body. */
  readmeZh: boolean
  /** README file that was found, relative to the repository root. */
  readmePath: string | null
  note: string | null
}

/** One text response used by the enrichment readers. */
export interface EnrichResponse {
  status: number
  text: string
  via?: string
}

/**
 * Inject point for offline tests: the default reads through the network
 * transport, a test passes a fake that returns fixture payloads instead.
 */
export type EnrichFetcher = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal; timeoutMs: number },
) => Promise<EnrichResponse>

export interface EnrichOptions {
  token?: string | null
  concurrency?: number
  /** Only the first N repositories get GitHub API calls; the rest are budget-skipped. */
  enrichCount?: number
  readmeCount?: number
  budgetMs?: number
  signal?: AbortSignal
  /** Offline-test override for every GitHub / raw README request. */
  fetcher?: EnrichFetcher
}

export interface EnrichResult {
  /** Facts keyed by `owner/name`; every requested repository has an entry. */
  facts: Map<string, RepoFacts>
  /** How many facts ended up with `enriched === true`. */
  enrichedCount: number
  /** GitHub API (`getJson`) calls actually made by this invocation. */
  apiCalls: number
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const CACHE = new Map<string, { at: number; facts: RepoFacts }>()

/**
 * GitHub API calls made by this process since the last report started. The
 * report resets it before generating, adds what `enrichRepos` returns, and
 * reads it afterwards; it is recorded, never capped here.
 */
let API_CALLS = 0

export function resetApiCalls(): void {
  API_CALLS = 0
}

export function addApiCalls(count: number): void {
  if (Number.isFinite(count) && count > 0) API_CALLS += count
}

export function apiCallsMade(): number {
  return API_CALLS
}

/** After a 403/429 the whole enrichment phase is skipped for a few minutes. */
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000
let RATE_LIMITED_UNTIL = 0

/** README file names tried in order; Chinese names are checked before README.md. */
export const README_CANDIDATES = [
  'README.zh-CN.md',
  'README_CN.md',
  'README.zh.md',
  'README-zh.md',
  'README.md',
]

/** File names that already prove the README is Chinese. */
const CHINESE_README_NAME = /^readme[._-](?:zh(?:[._-]cn)?|cn)\.md$/i
/** Fallback for README.md: any CJK code point means the body is Chinese. */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

export function clearEnrichCache(): void {
  CACHE.clear()
  RATE_LIMITED_UNTIL = 0
}

export function emptyFacts(fullName: string, note: string | null = null): RepoFacts {
  return {
    fullName,
    enriched: false,
    topics: [],
    license: null,
    archived: false,
    createdAt: null,
    pushedAt: null,
    openIssues: null,
    homepage: null,
    readmeSnippet: null,
    readmeZh: false,
    readmePath: null,
    note,
  }
}

/**
 * Read a token file without ever throwing or printing its contents. A BOM,
 * surrounding whitespace and one pair of matching straight quotes are removed;
 * every failure (missing file, permission, binary body) degrades to ''.
 */
function readTokenFile(file: string): string {
  try {
    let value = readFileSync(file, 'utf8')
    if (value.charCodeAt(0) === 0xfeff) value = value.slice(1)
    value = value.trim()
    if (value.length >= 2) {
      const first = value.charAt(0)
      const last = value.charAt(value.length - 1)
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1).trim()
      }
    }
    return value
  } catch {
    return ''
  }
}

/**
 * Resolve the GitHub token in one fixed order: explicit argument, then
 * `GITHUB_TOKEN`, then `GH_TOKEN`, then the token file (`GITHUB_TOKEN_FILE`,
 * or `%USERPROFILE%\.dsh\github-token`), then ''. The value is never logged.
 */
export function githubToken(explicit?: string | null): string {
  const direct =
    String(explicit ?? '').trim() ||
    String(process.env.GITHUB_TOKEN ?? '').trim() ||
    String(process.env.GH_TOKEN ?? '').trim()
  if (direct) return direct
  const configuredFile = String(process.env.GITHUB_TOKEN_FILE ?? '').trim()
  const home = String(process.env.USERPROFILE ?? '').trim() || homedir()
  const file = configuredFile || path.join(home, '.dsh', 'github-token')
  return readTokenFile(file)
}

function authHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    'user-agent': 'dsh-github-trending/1.0',
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  }
  if (token) headers.authorization = `Bearer ${token}`
  return headers
}

const DEFAULT_FETCHER: EnrichFetcher = async (url, init) => {
  const response = await fetchText(url, init)
  return { status: response.status, text: response.text, via: response.via }
}

class RateLimitedError extends Error {}

/**
 * Reads one GitHub API URL and counts the call in the per-invocation `stats`
 * object. The process-wide report counter is fed by `enrichRepos`'s return
 * value instead, so a report never double counts.
 */
async function getJson(
  url: string,
  token: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  fetcher: EnrichFetcher,
  stats: { apiCalls: number },
): Promise<any> {
  stats.apiCalls += 1
  const response = await fetcher(url, { headers: authHeaders(token), signal, timeoutMs })
  noteFetchVia(response.via)
  if (response.status === 403 || response.status === 429) {
    throw new RateLimitedError(`GitHub API rate limit reached (HTTP ${response.status}, via ${response.via})`)
  }
  if (response.status !== 200) throw new Error(`GitHub API HTTP ${response.status} via ${response.via}`)
  try {
    return JSON.parse(response.text)
  } catch {
    throw new Error(`GitHub API returned non-JSON via ${response.via}`)
  }
}

function shorten(text: string, max: number): string {
  const value = text.trim()
  if (value.length <= max) return value
  const cut = value.slice(0, max)
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('。'), cut.lastIndexOf('\n'))
  return `${(stop > max * 0.5 ? cut.slice(0, stop + 1) : cut).trim()}…`
}

function readmeToSnippet(markdown: string): string {
  const lines = String(markdown ?? '').split(/\r?\n/)
  const kept: string[] = []
  let inFence = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (!trimmed) continue
    if (/^\[!\[/.test(trimmed)) continue
    if (/^!\[/.test(trimmed)) continue
    if ((trimmed.match(/\]\(/g) || []).length >= 3) continue // navigation / table-of-contents line
    if (/^<\/?(p|div|img|a|h\d|br|table|tr|td|th|center|picture|source|details|summary)\b/i.test(trimmed)) continue
    if (/^<[^>]+>$/.test(trimmed)) continue
    if (/^\|/.test(trimmed)) continue
    if (/^[-=*_]{3,}$/.test(trimmed)) continue
    if (/^#{1,6}\s*$/.test(trimmed)) continue
    if (/^(badge|shields\.io)/i.test(trimmed)) continue
    if (/^(docs|documentation|license|contributing|sponsor)\b/i.test(trimmed) && trimmed.length < 40) continue
    kept.push(trimmed.replace(/^#{1,6}\s*/, ''))
    if (kept.join(' ').length > 1400) break
  }
  const text = cleanText(kept.join(' '))
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return shorten(text, 520)
}

interface ReadmeResult {
  markdown: string
  path: string
  zh: boolean
}

/** Branch refs tried in order by the raw README channel; `HEAD` is the default branch alias. */
export const RAW_README_REFS = ['HEAD', 'main', 'master']

/** Per-request timeout of the raw README channel, independent of the API budget. */
const README_RAW_TIMEOUT_MS = 8000

/** Chinese file names are Chinese by definition; `README.md` is classified by its body. */
function classifyReadme(candidate: string, body: string): boolean {
  return CHINESE_README_NAME.test(candidate) || (candidate === 'README.md' && CJK.test(body))
}

/**
 * Raw README channel: `raw.githubusercontent.com` is served by a CDN and is
 * **not** charged against the GitHub API quota, so it keeps working after the
 * 60/hour unauthenticated API budget is exhausted.
 *
 * Every entry of `candidates` is requested on the default branch alias `HEAD`;
 * when raw cannot answer, `main` and then `master` are probed as a fallback.
 * A non-empty `200` is a hit, anything else (404, timeout, empty body) is a
 * miss, and one failure never aborts the list. The whole channel stops once its
 * time budget (the per-request timeout, at least 3s) is spent. Returns `null`
 * when no candidate exists on any ref.
 */
export async function fetchReadmeViaRaw(
  fullName: string,
  candidates: readonly string[] = README_CANDIDATES,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  fetcher: EnrichFetcher,
): Promise<ReadmeResult | null> {
  const budgetDeadline = Date.now() + Math.max(3000, timeoutMs)
  for (const ref of RAW_README_REFS) {
    for (const candidate of candidates) {
      if (Date.now() > budgetDeadline) return null
      const url = `https://raw.githubusercontent.com/${fullName}/${ref}/${candidate}`
      try {
        const response = await fetcher(url, {
          headers: { 'user-agent': 'dsh-github-trending/1.0' },
          signal,
          timeoutMs,
        })
        noteFetchVia(response.via)
        if (response.status !== 200) continue
        const body = response.text.slice(0, 200000)
        if (!body.trim()) continue
        return { markdown: body, path: candidate, zh: classifyReadme(candidate, body) }
      } catch {
        continue
      }
    }
  }
  return null
}

/**
 * GitHub API contents channel, kept as the fallback when the raw channel finds
 * nothing. `GET /repos/{owner}/{repo}/readme` resolves the file GitHub itself
 * considers the repository README, including non-standard names such as
 * `readme.rst`. Costs one API call and returns `null` on any failure.
 */
async function fetchReadmeViaApi(
  fullName: string,
  token: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  fetcher: EnrichFetcher,
  stats: { apiCalls: number },
): Promise<ReadmeResult | null> {
  stats.apiCalls += 1
  try {
    const response = await fetcher(`https://api.github.com/repos/${fullName}/readme`, {
      headers: authHeaders(token),
      signal,
      timeoutMs,
    })
    noteFetchVia(response.via)
    if (response.status !== 200) return null
    const payload = JSON.parse(response.text)
    const readmePath = String(payload?.path ?? payload?.name ?? 'README.md')
    let markdown = ''
    if (typeof payload?.content === 'string' && payload.encoding === 'base64') {
      markdown = Buffer.from(String(payload.content).replace(/\s+/g, ''), 'base64').toString('utf8')
    } else if (typeof payload?.content === 'string') {
      markdown = payload.content
    } else if (!String(response.text).trimStart().startsWith('{')) {
      markdown = response.text
    }
    if (!markdown.trim()) return null
    return { markdown, path: readmePath, zh: classifyReadme(readmePath, markdown) }
  } catch {
    return null
  }
}

async function enrichOne(
  repo: TrendingRepo,
  options: EnrichOptions,
  token: string,
  withMetadata: boolean,
  withReadme: boolean,
  deadline: number,
  fetcher: EnrichFetcher,
  stats: { apiCalls: number; rateLimited: string | null },
): Promise<RepoFacts> {
  const cached = CACHE.get(repo.fullName)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.facts

  const facts = emptyFacts(repo.fullName)
  const remaining = Math.max(1500, deadline - Date.now())
  let apiRateLimited = false

  if (!withMetadata) facts.note = stats.rateLimited ?? 'github api rate limited (cooldown)'

  if (withMetadata) {
    try {
      const payload = await getJson(
        `https://api.github.com/repos/${repo.fullName}`,
        token,
        Math.min(8000, remaining),
        options.signal,
        fetcher,
        stats,
      )
      if (payload && typeof payload === 'object') {
        if (Array.isArray(payload.topics)) facts.topics = payload.topics.map((item: unknown) => String(item)).filter(Boolean)
        if (payload.license && payload.license.spdx_id) facts.license = String(payload.license.spdx_id)
        facts.archived = payload.archived === true
        facts.createdAt = payload.created_at ? String(payload.created_at) : null
        facts.pushedAt = payload.pushed_at ? String(payload.pushed_at) : null
        facts.openIssues = typeof payload.open_issues_count === 'number' ? payload.open_issues_count : null
        facts.homepage = payload.homepage ? String(payload.homepage) : null
        facts.enriched = true
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      facts.note = message
      if (error instanceof RateLimitedError) {
        // Do not abort enrichment: the raw README channel does not spend quota.
        stats.rateLimited = message
        apiRateLimited = true
      }
    }
  }

  if (withReadme && deadline - Date.now() > 2000) {
    const readmeTimeout = Math.min(README_RAW_TIMEOUT_MS, Math.max(1500, deadline - Date.now()))
    let readme = await fetchReadmeViaRaw(repo.fullName, README_CANDIDATES, readmeTimeout, options.signal, fetcher)
    if (!readme && !apiRateLimited && deadline - Date.now() > 2000) {
      // Raw missed every candidate: fall back to the API contents channel.
      readme = await fetchReadmeViaApi(
        repo.fullName,
        token,
        Math.min(README_RAW_TIMEOUT_MS, Math.max(1500, deadline - Date.now())),
        options.signal,
        fetcher,
        stats,
      )
    }
    if (readme) {
      const snippet = readmeToSnippet(readme.markdown)
      facts.readmeSnippet = snippet || null
      facts.readmePath = readme.path
      facts.readmeZh = readme.zh
    }
  }

  CACHE.set(repo.fullName, { at: Date.now(), facts })
  return facts
}

function boundedCount(value: unknown, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return max
  return Math.max(0, Math.min(max, Math.round(parsed)))
}

/**
 * Enriches at most `enrichCount` repositories with a bounded worker pool. The
 * remaining repositories are returned immediately with
 * `note === 'not enriched (budget)'` and never trigger a request. The result
 * carries the number of API calls this invocation really made so the report can
 * accumulate it into its own counter.
 */
export async function enrichRepos(repos: TrendingRepo[], options: EnrichOptions = {}): Promise<EnrichResult> {
  const results = new Map<string, RepoFacts>()
  const stats: { apiCalls: number; rateLimited: string | null } = { apiCalls: 0, rateLimited: null }
  const enrichCount = boundedCount(options.enrichCount, repos.length)

  for (let index = enrichCount; index < repos.length; index += 1) {
    const repo = repos[index]
    results.set(repo.fullName, emptyFacts(repo.fullName, 'not enriched (budget)'))
  }

  const token = githubToken(options.token)
  const concurrency = Math.max(1, Math.min(6, options.concurrency ?? 4))
  const readmeCount = Math.max(0, Math.min(enrichCount, options.readmeCount ?? 8))
  const deadline = Date.now() + Math.max(2000, options.budgetMs ?? 12000)
  const fetcher = options.fetcher ?? DEFAULT_FETCHER
  const queue = repos.slice(0, enrichCount).map((repo, index) => ({ repo, index }))

  // While the API cooldown is active, metadata is skipped but the raw README
  // channel still runs: it does not spend the GitHub API quota.
  let stopped: string | null = Date.now() < RATE_LIMITED_UNTIL ? 'github api rate limited (cooldown)' : null

  const worker = async (): Promise<void> => {
    for (;;) {
      const next = queue.shift()
      if (!next) return
      if (Date.now() > deadline) {
        results.set(next.repo.fullName, emptyFacts(next.repo.fullName, 'enrichment budget exhausted'))
        continue
      }
      const withReadme = next.index < readmeCount
      const withMetadata = !stopped
      try {
        const facts = await enrichOne(next.repo, options, token, withMetadata, withReadme, deadline, fetcher, stats)
        results.set(next.repo.fullName, facts)
        if (stats.rateLimited && !stopped) stopped = stats.rateLimited
      } catch (error) {
        // enrichOne degrades every API failure to `facts.note`; this is only a
        // last-resort guard so one broken repository cannot abort the report.
        const message = error instanceof Error ? error.message : String(error)
        results.set(next.repo.fullName, emptyFacts(next.repo.fullName, message))
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))

  if (stats.rateLimited && /rate limit/i.test(stats.rateLimited)) {
    RATE_LIMITED_UNTIL = Date.now() + RATE_LIMIT_COOLDOWN_MS
  }

  for (const repo of repos) {
    if (!results.has(repo.fullName)) results.set(repo.fullName, emptyFacts(repo.fullName, 'not enriched'))
  }
  return summarize(results, repos, stats.apiCalls)
}

function summarize(results: Map<string, RepoFacts>, repos: TrendingRepo[], apiCalls: number): EnrichResult {
  let enrichedCount = 0
  for (const repo of repos) {
    if (results.get(repo.fullName)?.enriched === true) enrichedCount += 1
  }
  return { facts: results, enrichedCount, apiCalls }
}
