/**
 * GitHub Trending scraper.
 *
 * GitHub exposes no public API for Trending, so this module parses the HTML of
 * https://github.com/trending. The parser is deliberately tolerant: every field
 * is optional and missing values degrade to null / 0 instead of throwing, so a
 * markup tweak on GitHub's side cannot take the whole plugin down.
 */

import { describeFetchError, fetchText } from './http.js'

export type TrendingSince = 'daily' | 'weekly' | 'monthly'

/**
 * Which board a repository came from: the selected language board, the
 * all-language board, or another popular language's board used as filler.
 */
export type BoardSource = 'language' | 'popular' | 'filler'

/** Only one shortfall cause exists: after every allowed board, there is nothing left to fetch. */
export type ShortfallReason = 'no-more-boards'

export interface TrendingRepo {
  rank: number
  owner: string
  name: string
  fullName: string
  url: string
  description: string
  language: string | null
  languageColor: string | null
  stars: number
  forks: number
  delta: number
  contributors: string[]
  source?: BoardSource
}

export interface LanguageOption {
  label: string
  slug: string
}

export interface FetchTrendingOptions {
  since: TrendingSince
  language?: string | null
  timeoutMs?: number
  signal?: AbortSignal
}

export const POPULAR_LANGUAGES: LanguageOption[] = [
  { label: 'Any language', slug: '' },
  { label: 'TypeScript', slug: 'typescript' },
  { label: 'JavaScript', slug: 'javascript' },
  { label: 'Python', slug: 'python' },
  { label: 'Rust', slug: 'rust' },
  { label: 'Go', slug: 'go' },
  { label: 'C++', slug: 'c++' },
  { label: 'C', slug: 'c' },
  { label: 'C#', slug: 'c#' },
  { label: 'Java', slug: 'java' },
  { label: 'Kotlin', slug: 'kotlin' },
  { label: 'Swift', slug: 'swift' },
  { label: 'Dart', slug: 'dart' },
  { label: 'PHP', slug: 'php' },
  { label: 'Ruby', slug: 'ruby' },
  { label: 'Zig', slug: 'zig' },
  { label: 'Lua', slug: 'lua' },
  { label: 'Shell', slug: 'shell' },
  { label: 'Jupyter Notebook', slug: 'jupyter-notebook' },
  { label: 'Vue', slug: 'vue' },
  { label: 'HTML', slug: 'html' },
  { label: 'CSS', slug: 'css' },
  { label: 'MDX', slug: 'mdx' },
  { label: 'Solidity', slug: 'solidity' },
]

export const PERIOD_DAYS: Record<TrendingSince, number> = {
  daily: 1,
  weekly: 7,
  monthly: 30,
}

export const PERIOD_ZH: Record<TrendingSince, string> = {
  daily: '今日',
  weekly: '本周',
  monthly: '本月',
}

export const PERIOD_EN: Record<TrendingSince, string> = {
  daily: 'today',
  weekly: 'this week',
  monthly: 'this month',
}

export function normalizeSince(value: unknown): TrendingSince {
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw === 'weekly' || raw === 'week' || raw === 'w') return 'weekly'
  if (raw === 'monthly' || raw === 'month' || raw === 'm') return 'monthly'
  return 'daily'
}

export function slugForLanguage(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const lower = raw.toLowerCase()
  if (lower === 'any' || lower === 'all' || lower === '*') return ''
  const known = POPULAR_LANGUAGES.find((entry) => entry.slug && (entry.slug === lower || entry.label.toLowerCase() === lower))
  if (known) return known.slug
  return lower.replace(/\s+/g, '-').replace(/[^a-z0-9+#.-]/g, '')
}

export function trendingUrl(since: TrendingSince, language?: string | null): string {
  const slug = slugForLanguage(language)
  const params = new URLSearchParams({ since })
  if (slug) params.set('language', slug)
  return `https://github.com/trending?${params.toString()}`
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
}

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.charAt(0) === '#') {
      const hex = body.charAt(1) === 'x' || body.charAt(1) === 'X'
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    const named = ENTITIES[body.toLowerCase()]
    return named === undefined ? match : named
  })
}

export function stripTags(input: string): string {
  return input
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
}

export function cleanText(input: string): string {
  return decodeEntities(stripTags(input)).replace(/\s+/g, ' ').trim()
}

/** Parses "1,930", "12.4k", "1.2M" and plain numbers. */
export function parseCount(input: string | undefined | null): number {
  if (!input) return 0
  const raw = String(input).replace(/[, _]/g, '').trim()
  const match = /^([0-9]*\.?[0-9]+)([kKmM]?)$/.exec(raw)
  if (!match) return 0
  const base = Number.parseFloat(match[1])
  if (!Number.isFinite(base)) return 0
  const suffix = match[2].toLowerCase()
  if (suffix === 'k') return Math.round(base * 1000)
  if (suffix === 'm') return Math.round(base * 1000000)
  return Math.round(base)
}

const BAD_LINKS = new Set(['login', 'signup', 'topics', 'orgs', 'sponsors', 'settings', 'explore', 'collections', 'trending'])

function firstRepoLink(html: string): { owner: string; name: string } | null {
  const pattern = /href="\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)"/g
  let match = pattern.exec(html)
  while (match) {
    const owner = match[1]
    const name = match[2]
    const link = `/${owner}/${name}`
    if (!BAD_LINKS.has(owner) && link !== '/sponsors/explore') return { owner, name }
    match = pattern.exec(html)
  }
  return null
}

function parseContributors(chunk: string): string[] {
  const marker = chunk.indexOf('Built by')
  if (marker < 0) return []
  const tail = chunk.slice(marker)
  const logins: string[] = []
  const pattern = /href="\/([A-Za-z0-9][A-Za-z0-9._-]*)"/g
  let match = pattern.exec(tail)
  while (match && logins.length < 5) {
    const login = match[1]
    if (!BAD_LINKS.has(login) && !logins.includes(login)) logins.push(login)
    match = pattern.exec(tail)
  }
  return logins
}

function parseDelta(chunk: string): number {
  const match = /([0-9][0-9,.]*)\s+stars?\s+(today|this week|this month)/i.exec(chunk)
  if (!match) return 0
  return parseCount(match[1])
}

/**
 * Reads the counter that follows a link such as `/owner/repo/stargazers`.
 * GitHub renders an octicon <svg> inside the anchor before the number, so the
 * segment is tag-stripped before the number is matched.
 */
function countAfterHref(chunk: string, hrefSuffix: string): number {
  const start = chunk.indexOf(hrefSuffix)
  if (start < 0) return 0
  const openEnd = chunk.indexOf('>', start)
  if (openEnd < 0) return 0
  const end = chunk.indexOf('</a>', openEnd)
  if (end < 0) return 0
  const text = cleanText(chunk.slice(openEnd + 1, end))
  const match = /([0-9][0-9,.]*\s*[kKmM]?)/.exec(text)
  return match ? parseCount(match[1]) : 0
}

function parseDescription(chunk: string): string {
  const patterns = [
    /<p\b[^>]*class="[^"]*\bcol-9\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i,
    /<p\b[^>]*class="[^"]*\bmy-1\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(chunk)
    if (match) {
      const text = cleanText(match[1])
      // Drop the trailing homepage link that GitHub appends to the description.
      const withoutUrl = text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim()
      if (withoutUrl) return withoutUrl
      if (text) return ''
    }
  }
  return ''
}

export function parseTrendingHtml(html: string, since: TrendingSince): TrendingRepo[] {
  const source = String(html ?? '')
  if (!source) return []
  const chunks = source.split(/<article\b[^>]*class="[^"]*\bBox-row\b/i).slice(1)
  const repos: TrendingRepo[] = []
  for (const raw of chunks) {
    const end = raw.indexOf('</article>')
    const chunk = end >= 0 ? raw.slice(0, end) : raw

    const titleMatch = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(chunk)
    const link = firstRepoLink(titleMatch ? titleMatch[1] : chunk)
    if (!link) continue

    const languageMatch = /itemprop="programmingLanguage"[^>]*>([^<]+)</i.exec(chunk)
    const colorMatch = /repo-language-color[^>]*?style="[^"]*?(#[0-9a-fA-F]{3,8})/i.exec(chunk)
    const stars = countAfterHref(chunk, `/stargazers"`)
    const forks = countAfterHref(chunk, `/forks"`)

    repos.push({
      rank: repos.length + 1,
      owner: link.owner,
      name: link.name,
      fullName: `${link.owner}/${link.name}`,
      url: `https://github.com/${link.owner}/${link.name}`,
      description: parseDescription(chunk),
      language: languageMatch ? cleanText(languageMatch[1]) || null : null,
      languageColor: colorMatch ? colorMatch[1].toLowerCase() : null,
      stars,
      forks,
      delta: parseDelta(chunk),
      contributors: parseContributors(chunk),
    })
  }
  return repos
}

/**
 * Flatten an error and its `cause` chain into one actionable line, so a failed
 * outbound request reports its real reason instead of undici's bare
 * `fetch failed`. Re-exported here because this module owns the transport
 * wording for Trending.
 */
export { describeFetchError }

export async function fetchTrending(options: FetchTrendingOptions): Promise<TrendingRepo[]> {
  const url = trendingUrl(options.since, options.language)
  const timeoutMs = options.timeoutMs ?? 20000
  try {
    const response = await fetchText(url, {
      timeoutMs,
      signal: options.signal,
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 dsh-github-trending/1.0',
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
      },
    })
    noteFetchVia(response.via)
    if (response.status !== 200) {
      throw new Error(`GitHub Trending responded with HTTP ${response.status} via ${response.via}`)
    }
    const repos = parseTrendingHtml(response.text, options.since)
    if (repos.length === 0) {
      throw new Error(
        `No repository could be parsed from the GitHub Trending page (via ${response.via}, ${response.text.length} chars${response.truncated ? ', truncated' : ''})`,
      )
    }
    return repos
  } catch (error) {
    throw new Error(`Could not load ${url}: ${describeFetchError(error)}`, { cause: error })
  }
}

/**
 * Backend id of the last successful `fetchText` call in this process. The board
 * fetcher and enrichment both report it, so the report can tell whether the
 * run went direct, through a fallback backend, or not at all.
 */
let LAST_VIA = ''

export function noteFetchVia(via: unknown): void {
  const value = String(via ?? '').trim()
  if (value) LAST_VIA = value
}

export function lastFetchVia(): string {
  return LAST_VIA
}

export function resetFetchVia(): void {
  LAST_VIA = ''
}

export interface BoardFetchOptions {
  since: TrendingSince
  language: string | null
  signal?: AbortSignal
  timeoutMs?: number
}

export interface BoardResult {
  repos: TrendingRepo[]
  via: string
}

/** Injectable board reader; tests pass a fixture-backed fake instead of the network. */
export type BoardFetcher = (options: BoardFetchOptions) => Promise<BoardResult>

const defaultBoardFetcher: BoardFetcher = async (options) => {
  const repos = await fetchTrending({
    since: options.since,
    language: options.language,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  })
  return { repos, via: LAST_VIA }
}

export interface FetchTrendingSetOptions {
  since: TrendingSince
  language?: string | null
  target?: number
  fetchBoard?: BoardFetcher
  signal?: AbortSignal
  timeoutMs?: number
}

export interface TrendingSet {
  repos: TrendingRepo[]
  shortfall: number
  shortfallReason: ShortfallReason | null
  lastVia: string
}

/**
 * Build one report's board set:
 *   - with a language: that language board first, then the all-language board,
 *     then the remaining popular language boards in `POPULAR_LANGUAGES` order;
 *   - without a language: the all-language board first, then the same popular
 *     language boards.
 * Every board is read at most once, duplicates are dropped by `fullName`, and
 * filling stops as soon as the target is met or every board has been read.
 * Returns the merged, re-ranked list plus the remaining shortfall and its
 * single cause.
 */
export async function fetchTrendingSet(options: FetchTrendingSetOptions): Promise<TrendingSet> {
  const since = normalizeSince(options.since)
  const language = slugForLanguage(options.language) || null
  const target = Math.max(0, Math.floor(Number(options.target ?? 50) || 0))
  const fetchBoard = options.fetchBoard ?? defaultBoardFetcher
  const seen = new Set<string>()
  const merged: TrendingRepo[] = []
  let lastVia = ''

  const collect = (repos: TrendingRepo[], source: BoardSource): void => {
    for (const repo of repos ?? []) {
      if (!repo || !repo.fullName) continue
      if (seen.has(repo.fullName)) continue
      seen.add(repo.fullName)
      merged.push({ ...repo, source })
    }
  }

  const readBoard = async (boardLanguage: string | null): Promise<BoardResult> => {
    const raw: any = await fetchBoard({ since, language: boardLanguage, signal: options.signal, timeoutMs: options.timeoutMs })
    // Tolerate fakes that return the repository array directly.
    if (Array.isArray(raw)) return { repos: raw, via: LAST_VIA }
    return { repos: Array.isArray(raw?.repos) ? raw.repos : [], via: String(raw?.via ?? '') }
  }

  /** Read one board, record its backend and merge it under `source`. */
  const pull = async (boardLanguage: string | null, source: BoardSource): Promise<void> => {
    const board = await readBoard(boardLanguage)
    lastVia = board.via || lastVia
    noteFetchVia(board.via)
    collect(board.repos, source)
  }

  if (language) {
    await pull(language, 'language')
  }
  if (merged.length < target) {
    await pull(null, 'popular')
  }
  if (merged.length < target) {
    for (const option of POPULAR_LANGUAGES) {
      if (!option.slug || option.slug === language) continue
      await pull(option.slug, 'filler')
      if (merged.length >= target) break
    }
  }

  const repos = merged.map((repo, index) => ({ ...repo, rank: index + 1 }))
  const shortfall = Math.max(0, target - repos.length)
  return {
    repos,
    shortfall,
    shortfallReason: shortfall > 0 ? 'no-more-boards' : null,
    lastVia,
  }
}