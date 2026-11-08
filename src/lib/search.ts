/**
 * GitHub Search fallback for the AI filter (Phase 2 `/ai`).
 *
 * When the current trending report has too few AI matches, the route asks this
 * module for a handful of GitHub Search results on the same natural-language
 * prompt. The default transport is the plugin's `fetchText` chain, so the
 * request inherits DNS-over-HTTPS / candidate-IP / proxy self-healing. A
 * `fetchImpl` seam keeps tests on a loopback server.
 *
 * Failures are never surfaced: a non-200 answer, a parse error or a transport
 * error all resolve to `[]`, and the route simply keeps the trending list.
 */

import { fetchText } from './http.js'

export const SEARCH_ENDPOINT = 'https://api.github.com/search/repositories'
export const SEARCH_TIMEOUT_MS = 15000
export const DEFAULT_SEARCH_LIMIT = 5

export interface SearchRepo {
  fullName: string
  name: string
  owner: string
  url: string
  description: string
  stars: number
  language: string | null
  origin: 'search'
}

export interface SearchReposOptions {
  query: string
  limit?: number
  token?: string | null
  /** Test seam: direct fetch implementation instead of the `fetchText` chain. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

function clampLimit(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return DEFAULT_SEARCH_LIMIT
  return Math.min(50, Math.max(1, Math.round(parsed)))
}

/** Build the exact Search URL (exported so tests can assert the contract). */
export function searchUrl(query: string, limit: unknown = DEFAULT_SEARCH_LIMIT): string {
  const params = new URLSearchParams({
    q: query,
    sort: 'stars',
    order: 'desc',
    per_page: String(clampLimit(limit)),
  })
  return `${SEARCH_ENDPOINT}?${params.toString()}`
}

function toRepo(item: any): SearchRepo | null {
  if (!item || typeof item !== 'object') return null
  const fullName = String(item.full_name ?? '').trim()
  if (!fullName) return null
  const owner = String(item.owner && item.owner.login ? item.owner.login : fullName.split('/')[0] ?? '').trim()
  const stars = Number(item.stargazers_count)
  return {
    fullName,
    name: String(item.name ?? fullName.split('/').pop() ?? '').trim(),
    owner,
    url: String(item.html_url ?? item.url ?? `https://github.com/${fullName}`).trim(),
    description: String(item.description ?? ''),
    stars: Number.isFinite(stars) ? stars : 0,
    language: item.language === null || item.language === undefined ? null : String(item.language),
    origin: 'search',
  }
}

/**
 * Search GitHub repositories for `query`, newest-stars first. Always resolves
 * with an array: no query, non-200, malformed JSON and transport errors all
 * return `[]`. The token, when present, is only used as an Authorization
 * header — never in the URL or the result rows.
 */
export async function searchRepos(options: SearchReposOptions): Promise<SearchRepo[]> {
  const query = String(options && options.query ? options.query : '').trim()
  if (!query) return []
  const url = searchUrl(query, options.limit)
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-github-trending-plus',
  }
  const token = String(options.token ?? '').trim()
  if (token) headers.authorization = `Bearer ${token}`
  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : SEARCH_TIMEOUT_MS

  try {
    let status = 0
    let text = ''
    if (options.fetchImpl) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await options.fetchImpl(url, { method: 'GET', headers, signal: controller.signal })
        status = Number(response && response.status)
        text = response ? await response.text() : ''
      } finally {
        clearTimeout(timer)
      }
    } else {
      const result = await fetchText(url, { headers, timeoutMs })
      status = result.status
      text = result.text
    }
    if (status !== 200) return []
    let payload: any
    try {
      payload = JSON.parse(text)
    } catch {
      return []
    }
    const rows = payload && Array.isArray(payload.items) ? payload.items : []
    const out: SearchRepo[] = []
    const seen = new Set<string>()
    for (const row of rows) {
      const repo = toRepo(row)
      if (!repo || seen.has(repo.fullName)) continue
      seen.add(repo.fullName)
      out.push(repo)
    }
    return out
  } catch {
    return []
  }
}
