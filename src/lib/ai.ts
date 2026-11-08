/**
 * AI-assisted repository matching (Phase 2 `/ai`).
 *
 * The panel sends one natural-language request; this module turns the current
 * report's repositories into a compact batch, asks one OpenAI-compatible chat
 * endpoint for a 0–100 match score plus a one-sentence Chinese reason per
 * repository, and returns a `{ fullName: { score, reason } }` map.
 *
 * Contract:
 *   - the request payload carries only `fullName`, `name`, `description` and
 *     `topics` per repository — never a README, a GitHub token or a local path;
 *   - the key is resolved through {@link resolveAiKey} in `translate.ts` (the
 *     same env/file chain as the intro channel) and is never returned/logged;
 *   - no key throws `AiNotConfiguredError` before any network call;
 *   - every transport or parse failure degrades to `{}` (never throws).
 */

import {
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  resolveAiKey,
} from './translate.js'

export const AI_TIMEOUT_MS = 25000
export const MAX_REASON_CHARS = 60

/** Public configuration accepted by the scoring call (never contains a key in responses). */
export interface AiConfig {
  baseUrl?: string
  model?: string
  /** Internal test seam; production calls resolve the key from the environment. */
  key?: string
  timeoutMs?: number
}

/** Configuration view for the panel: no key, only where and which model. */
export interface AiStatus {
  configured: boolean
  host: string
  model: string
}

/** One repository as sent to the model. Deliberately smaller than `TranslateItem`. */
export interface ScoreRepoInput {
  fullName: string
  name: string
  description: string
  topics: string[]
}

export interface RepoScore {
  score: number
  reason: string
}

export interface ScoreReposOptions {
  prompt: string
  repos: ScoreRepoInput[]
  config?: AiConfig
  /** Test seam: route model traffic to a loopback server instead of global fetch. */
  fetchImpl?: typeof fetch
}

export interface SortWeights {
  match?: number
  growth?: number
}

export interface WeightedRepo {
  matchScore?: number
  delta?: number
}

/** Thrown when no key is configured; the route maps it to HTTP 412. */
export class AiNotConfiguredError extends Error {
  readonly code = 'AI_NOT_CONFIGURED'

  constructor(message = 'AI key is not configured') {
    super(message)
    this.name = 'AiNotConfiguredError'
  }
}

/**
 * Fixed system prompt: one batch, strict JSON, 0–100 score, one Chinese
 * sentence per repository, 0 for irrelevant rows. Kept exported so tests and
 * the route assert the exact contract that is sent.
 */
export const SCORE_SYSTEM_PROMPT = [
  '你是仓库筛选助手。根据用户需求给每个仓库打 0–100 的匹配度。',
  '要求：',
  '1. 只依据用户需求与给出的仓库名、简介、topics 判断，不得编造材料之外的事实。',
  '2. 完全不相关或只沾边的给 0；越贴合需求分数越高。',
  '3. 每个仓库给一句中文理由，不超过 60 字。',
  '4. 只输出 JSON：{"items":[{"fullName":"...","score":78,"reason":"..."}]}',
].join('\n')

function cleanText(value: unknown): string {
  return String(value ?? '').trim()
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function normalizeBaseUrl(config: AiConfig): string {
  return stripTrailingSlash(cleanText(config.baseUrl)) || DEFAULT_AI_BASE_URL
}

function normalizeModel(config: AiConfig): string {
  return cleanText(config.model) || DEFAULT_AI_MODEL
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return ''
  }
}

function clip(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length > max ? chars.slice(0, max).join('') : text
}

/** Clamp any numeric score to an integer in [0, 100]. */
function clampScore(value: unknown): number | null {
  const score = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(score)) return null
  return Math.min(100, Math.max(0, Math.round(score)))
}

/** Pull the JSON object out of a model reply, tolerating a ```json fence. */
function extractJson(content: string): string | null {
  let text = String(content ?? '').trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fenced) text = fenced[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  return text.slice(start, end + 1)
}

/** Read `choices[0].message.content` from a chat-completion body. */
function messageContent(payload: any): string | null {
  const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null
  let content = choice && choice.message ? choice.message.content : null
  if (Array.isArray(content)) {
    content = content
      .map((part: any) => (typeof part === 'string' ? part : String(part && part.text ? part.text : '')))
      .join('')
  }
  if (content && typeof content === 'object') {
    try {
      content = JSON.stringify(content)
    } catch {
      return null
    }
  }
  return typeof content === 'string' ? content : null
}

/** Parse the model reply into validated scores; unknown names are dropped. */
export function parseScoreReply(raw: string, allowed: Set<string>): Record<string, RepoScore> {
  let payload: any
  try {
    payload = JSON.parse(raw)
  } catch {
    return {}
  }
  const content = messageContent(payload)
  if (!content) return {}
  const jsonText = extractJson(content)
  if (!jsonText) return {}
  let parsed: any
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return {}
  }
  const rows = Array.isArray(parsed && parsed.items)
    ? parsed.items
    : Array.isArray(parsed)
      ? parsed
      : []
  const out: Record<string, RepoScore> = {}
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const fullName = cleanText((row as any).fullName)
    if (!fullName || !allowed.has(fullName)) continue
    const score = clampScore((row as any).score)
    if (score === null) continue
    const reason = clip(cleanText((row as any).reason).replace(/\s+/g, ' '), MAX_REASON_CHARS)
    out[fullName] = { score, reason }
  }
  return out
}

/**
 * Public status without the key: whether a key resolves, which host would be
 * contacted and which model would be requested.
 */
export function aiStatus(config: AiConfig = {}): AiStatus {
  const baseUrl = normalizeBaseUrl(config)
  return {
    configured: Boolean(resolveAiKey(process.env, config.key)),
    host: hostOf(baseUrl),
    model: normalizeModel(config),
  }
}

function normalizeRepo(raw: ScoreRepoInput): ScoreRepoInput | null {
  if (!raw || typeof raw !== 'object') return null
  const fullName = cleanText((raw as ScoreRepoInput).fullName)
  if (!fullName) return null
  return {
    fullName,
    name: cleanText((raw as ScoreRepoInput).name),
    description: String((raw as ScoreRepoInput).description ?? ''),
    topics: Array.isArray((raw as ScoreRepoInput).topics)
      ? (raw as ScoreRepoInput).topics.map((topic) => cleanText(topic)).filter(Boolean)
      : [],
  }
}

/**
 * Score a batch of repositories in one request. Resolves with a map keyed by
 * `fullName`; rows for unknown names are dropped, scores are clamped to 0–100
 * integers and reasons are capped at 60 characters. Throws only
 * `AiNotConfiguredError`; every other failure returns `{}`.
 */
export async function scoreRepos(options: ScoreReposOptions): Promise<Record<string, RepoScore>> {
  const prompt = String(options && options.prompt ? options.prompt : '').trim()
  const config = (options && options.config) || {}
  const key = resolveAiKey(process.env, config.key)
  if (!key) throw new AiNotConfiguredError()

  const input: ScoreRepoInput[] = []
  const seen = new Set<string>()
  for (const raw of Array.isArray(options.repos) ? options.repos : []) {
    const repo = normalizeRepo(raw)
    if (!repo || seen.has(repo.fullName)) continue
    seen.add(repo.fullName)
    input.push(repo)
  }
  if (input.length === 0) return {}

  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timeoutMs =
    typeof config.timeoutMs === 'number' && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
      ? config.timeoutMs
      : AI_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const body = {
    model: normalizeModel(config),
    temperature: 0,
    stream: false,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SCORE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: JSON.stringify({
          prompt,
          items: input.map((repo) => ({
            fullName: repo.fullName,
            name: repo.name,
            description: repo.description,
            topics: repo.topics,
          })),
        }),
      },
    ],
  }

  try {
    const response = await fetchImpl(`${normalizeBaseUrl(config)}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response || !response.ok) return {}
    let text = ''
    try {
      text = await response.text()
    } catch {
      return {}
    }
    return parseScoreReply(text, new Set(input.map((repo) => repo.fullName)))
  } catch {
    return {}
  } finally {
    clearTimeout(timer)
  }
}

function finiteWeight(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Sort by `matchWeight * score + growthWeight * (delta / maxDelta * 100)`,
 * descending. When every delta is 0 the growth term is dropped and the list is
 * ordered by match score alone. Returns a copy; input order breaks ties.
 */
export function sortByWeights<T extends WeightedRepo>(repos: readonly T[], weights: SortWeights = {}): T[] {
  const list = Array.isArray(repos) ? repos.slice() : []
  const matchWeight = finiteWeight(weights.match, 0.6)
  const growthWeight = finiteWeight(weights.growth, 0.4)
  let maxDelta = 0
  for (const repo of list) {
    const delta = Number(repo.delta)
    if (Number.isFinite(delta) && delta > maxDelta) maxDelta = delta
  }
  const scored = list.map((repo, index) => {
    const rawScore = Number(repo.matchScore)
    const score = Number.isFinite(rawScore) ? Math.min(100, Math.max(0, rawScore)) : 0
    const delta = Number(repo.delta)
    const growth = maxDelta > 0 && Number.isFinite(delta) ? (Math.max(0, delta) / maxDelta) * 100 : 0
    const value = maxDelta > 0 ? matchWeight * score + growthWeight * growth : score
    return { repo, index, value }
  })
  scored.sort((a, b) => b.value - a.value || a.index - b.index)
  return scored.map((entry) => entry.repo)
}
