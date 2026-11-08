// Generated from src/lib/translate.ts - do not edit by hand; run `node build.mjs`.
/**
 * AI Chinese introduction channel.
 *
 * The panel first renders the template intro from the analysis pipeline, then
 * asks this module (through the host route) for a model-written Chinese intro.
 * When no key is configured, {@link readAiConfig} reports `configured: false`
 * and the caller keeps the template text — this module never invents a key and
 * never throws: every transport or parsing failure degrades to `{}`.
 *
 * The public config object intentionally carries no key. {@link translateIntros}
 * resolves the key at request time from `DSH_GITHUB_TRENDING_AI_KEY`,
 * `DEEPSEEK_API_KEY`, then a key file (`DSH_GITHUB_TRENDING_AI_KEY_FILE`, or
 * `%USERPROFILE%\.dsh\github-trending-ai-key` by default). The only key ever
 * logged/returned is a boolean `configured`; file read failures degrade to
 * "not configured" and never throw.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_AI_BASE_URL = 'https://api.deepseek.com'
export const DEFAULT_AI_MODEL = 'deepseek-flash'
export const TRANSLATE_TIMEOUT_MS = 20000
export const TRANSLATE_CACHE_TTL_MS = 6 * 60 * 60 * 1000
export const MAX_INTRO_CHARS = 60
export const MAX_ONBOARDING_CHARS = 120
export const MAX_README_CHARS = 400

/** Public view of the AI configuration; the key itself is never included. */
                           
                     
                 
               
 

/** One repository as the route passes it to the model. */
                                
                  
              
                     
                  
                                                                 
                       
 

/** One parsed model row: the Chinese intro plus the 上手门槛 text. */
                                  
               
                    
 

/**
 * Internal config accepted by {@link translateIntros}. The public
 * {@link AiConfig} never contains `key`; tests may inject one, otherwise the
 * module resolves it from the environment.
 */
                                                   
              
                    
                          
 

/**
 * System prompt is fixed here so the route, tests and any future caller share
 * one contract: material-only, 1–2 Chinese sentences, ≤60 字, no Latin words
 * except a fixed term list, no star/fork/growth numbers, empty when unsure.
 * Each row also carries an `onboarding` field with the 上手门槛 text: two
 * sentences at most, no time estimate, no invented commands.
 */
export const INTRO_SYSTEM_PROMPT = [
  '你是中文技术编辑。只依据用户提供的仓库材料写中文介绍，不得编造材料之外的事实。',
  '要求：',
  '1. 用 1–2 句自然中文说明项目做什么、解决什么问题，整段不超过 60 字。',
  '2. 除专有名词与术语（LLM/RAG/CLI/API/SDK/MCP/GPU/AI/UI）外不得出现英文。',
  '3. 不得出现 star/fork/增长数字或贡献者数量。',
  '4. 材料不足时输出空字符串，不要猜测。',
  '5. 另外为每个仓库写 onboarding（中文，最多两句）：',
  '   第一句「需要先会：……」只写必需的前置知识；',
  '   第二句「第一次能跑到：……」写清按 README 能跑到什么程度，尽量引用 README 里的安装/运行命令原文。',
  '   · 不许写预计耗时（不要出现“小时”“分钟”“天”）',
  '   · 材料不足就输出空字符串',
  '   · 不许编造 README 里没有的命令',
  '6. 只输出 JSON：{"items":[{"fullName":"...","intro":"...","onboarding":"..."}]}',
].join('\n')

                                                 

function cleanEnvValue(value         )         {
  return String(value ?? '').trim()
}

function stripTrailingSlash(value        )         {
  return value.replace(/\/+$/, '')
}

/** Default key-file location; Windows keys off USERPROFILE like the shell does. */
function defaultKeyFilePath(env         )         {
  if (process.platform === 'win32') {
    const home =
      cleanEnvValue(env.USERPROFILE) || cleanEnvValue(process.env.USERPROFILE) || os.homedir()
    return path.join(home, '.dsh', 'github-trending-ai-key')
  }
  return path.join(os.homedir(), '.dsh', 'github-trending-ai-key')
}

/**
 * Normalize key-file text: strip one leading UTF-8 BOM, trim whitespace, then
 * drop one pair of matching single/double quotes. Values are never logged.
 */
function cleanFileKey(raw         )         {
  let value = String(raw ?? '')
  if (value.charCodeAt(0) === 0xfeff) value = value.slice(1)
  value = value.trim()
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1)
    }
  }
  return value.trim()
}

/** Read the key file; any failure (missing, empty, unreadable) means "no key". */
function readKeyFromFile(env         )         {
  try {
    const filePath = cleanEnvValue(env.DSH_GITHUB_TRENDING_AI_KEY_FILE) || defaultKeyFilePath(env)
    if (!filePath) return ''
    return cleanFileKey(readFileSync(filePath, 'utf8'))
  } catch {
    return ''
  }
}

/**
 * Resolve the key, highest priority first: explicit (internal test seam), then
 * the primary environment variable, the fallback environment variable, and
 * finally the key file. The resolved value stays module-private.
 */
function resolveKey(env         , explicit          )         {
  return (
    cleanEnvValue(explicit) ||
    cleanEnvValue(env.DSH_GITHUB_TRENDING_AI_KEY) ||
    cleanEnvValue(env.DEEPSEEK_API_KEY) ||
    readKeyFromFile(env)
  )
}

/**
 * Minimal key resolver for other AI channels (Phase 2 `/ai`).
 *
 * Returns the same key {@link translateIntros} would use — explicit test seam,
 * `DSH_GITHUB_TRENDING_AI_KEY`, `DEEPSEEK_API_KEY`, then the key file — or an
 * empty string when none is configured. It never logs the value and never
 * throws, so callers can decide between "not configured" and a transport error.
 */
export function resolveAiKey(env          = process.env, explicit          )         {
  return resolveKey(env, explicit)
}

/**
 * Read the public AI config from `env` (defaults to `process.env`).
 * `configured` is true when an environment variable or the key file holds a
 * non-empty key; the key value is never returned.
 */
export function readAiConfig(env          = process.env)           {
  const baseUrl = stripTrailingSlash(cleanEnvValue(env.DSH_GITHUB_TRENDING_AI_BASE_URL)) || DEFAULT_AI_BASE_URL
  const model = cleanEnvValue(env.DSH_GITHUB_TRENDING_AI_MODEL) || DEFAULT_AI_MODEL
  return {
    configured: Boolean(resolveKey(env)),
    baseUrl,
    model,
  }
}

/** First paragraph of a README excerpt, used for both the model input and the cache key. */
export function firstParagraph(text         )         {
  const value = String(text ?? '').replace(/\r\n?/g, '\n')
  const first = value.split(/\n\s*\n/)[0] ?? ''
  return first.trim() || value.trim()
}

function clip(text        , max        )         {
  const chars = Array.from(text)
  return chars.length > max ? chars.slice(0, max).join('') : text
}

function normalizeItem(item               )                       {
  if (!item || typeof item !== 'object') return null
  const fullName = cleanEnvValue(item.fullName)
  if (!fullName) return null
  const topics = Array.isArray(item.topics) ? item.topics.map((topic) => cleanEnvValue(topic)).filter(Boolean) : []
  return {
    fullName,
    name: cleanEnvValue(item.name),
    description: String(item.description ?? ''),
    topics,
    readmeSnippet: clip(firstParagraph(item.readmeSnippet), MAX_README_CHARS),
  }
}

function hashText(text        )         {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

/** Cache key: repository + hash(description + topics + README first paragraph). */
function cacheKeyFor(item               )         {
  return `${item.fullName}\u0000${hashText(
    `${item.description}${item.topics.join(',')}${firstParagraph(item.readmeSnippet)}`,
  )}`
}

                      
            
               
                    
 

const CACHE = new Map                    ()

/** Test seam: reset the 6-hour in-memory cache. */
export function clearTranslateCache()       {
  CACHE.clear()
}

/** Remove markdown decoration so the card shows plain prose. */
function stripMarkdown(text        )         {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_#~>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanIntro(value         )         {
  const text = stripMarkdown(String(value ?? ''))
  if (!text) return ''
  if (/^信息不足[。.!！]?$/.test(text)) return ''
  return clip(text, MAX_INTRO_CHARS)
}

/** A time estimate must never enter the onboarding text; drop the whole row then. */
const TIME_ESTIMATE_RE = /小时|半天|分钟|天/

/**
 * Onboarding follows the same material-only rule as the intro and additionally
 * never states an expected duration. An empty, "信息不足" or time-estimating
 * value degrades to '' so the caller keeps the rule-based sentence.
 */
function cleanOnboarding(value         )         {
  const text = stripMarkdown(String(value ?? ''))
  if (!text) return ''
  if (/^信息不足[。.!！]?$/.test(text)) return ''
  if (TIME_ESTIMATE_RE.test(text)) return ''
  return clip(text, MAX_ONBOARDING_CHARS)
}

/** Pull the JSON object out of a model reply, tolerating a ```json fence. */
function extractJson(content        )                {
  let text = String(content ?? '').trim()
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenced) text = fenced[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  return text.slice(start, end + 1)
}

                       
                  
               
                    
 

/** Parse the chat-completion body into validated `{fullName, intro, onboarding}` rows. */
function parseChatCompletion(raw        , allowed             )                {
  let payload     
  try {
    payload = JSON.parse(raw)
  } catch {
    return []
  }
  const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null
  let content = choice && choice.message ? choice.message.content : null
  if (Array.isArray(content)) {
    content = content
      .map((part     ) => (typeof part === 'string' ? part : String(part && part.text ? part.text : '')))
      .join('')
  }
  if (typeof content !== 'string') return []
  const jsonText = extractJson(content)
  if (!jsonText) return []
  let parsed     
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return []
  }
  const rows = Array.isArray(parsed && parsed.items) ? parsed.items : Array.isArray(parsed) ? parsed : []
  const out                = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const fullName = cleanEnvValue((row       ).fullName)
    if (!allowed.has(fullName)) continue
    const intro = cleanIntro((row       ).intro)
    if (!intro) continue
    out.push({ fullName, intro, onboarding: cleanOnboarding((row       ).onboarding) })
  }
  return out
}

async function requestIntros(
  items                 ,
  config                 ,
  key        ,
  timeoutMs        ,
)                         {
  const fetchImpl = config.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const allowed = new Set(items.map((item) => item.fullName))
  const body = {
    model: config.model,
    temperature: 0.3,
    stream: false,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: INTRO_SYSTEM_PROMPT },
      {
        role: 'user',
        content: JSON.stringify({
          items: items.map((item) => ({
            fullName: item.fullName,
            name: item.name,
            description: item.description,
            topics: item.topics,
            readmeSnippet: item.readmeSnippet,
          })),
        }),
      },
    ],
  }
  try {
    const response = await fetchImpl(`${stripTrailingSlash(config.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response || !response.ok) return []
    let text = ''
    try {
      text = await response.text()
    } catch {
      return []
    }
    return parseChatCompletion(text, allowed)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Translate a batch of repository intros in one request. Returns a
 * `{ fullName: { intro, onboarding } }` map; unknown names, empty intros and the
 * "信息不足" sentinel are dropped so the caller keeps its template text. An empty
 * or time-estimating onboarding degrades to `''`, which tells the client to keep
 * the rule-based 上手门槛 sentence. Never throws.
 */
export async function translateIntros(
  items                 ,
  config                  = { configured: false, baseUrl: DEFAULT_AI_BASE_URL, model: DEFAULT_AI_MODEL },
)                                           {
  const input                  = []
  const seen = new Set        ()
  for (const raw of Array.isArray(items) ? items : []) {
    const item = normalizeItem(raw)
    if (!item || seen.has(item.fullName)) continue
    seen.add(item.fullName)
    input.push(item)
  }
  if (input.length === 0) return {}

  const key = resolveKey(process.env, config.key)
  if (!key) return {}

  const now = Date.now()
  const result                                  = {}
  const pending                  = []
  for (const item of input) {
    const cached = CACHE.get(cacheKeyFor(item))
    if (cached && now - cached.at < TRANSLATE_CACHE_TTL_MS) {
      result[item.fullName] = { intro: cached.intro, onboarding: cached.onboarding }
    } else pending.push(item)
  }
  if (pending.length === 0) return result

  const timeoutMs =
    typeof config.timeoutMs === 'number' && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
      ? config.timeoutMs
      : TRANSLATE_TIMEOUT_MS
  const parsed = await requestIntros(pending, { ...config, baseUrl: stripTrailingSlash(config.baseUrl || DEFAULT_AI_BASE_URL) }, key, timeoutMs)
  const byName = new Map(pending.map((item) => [item.fullName, item]))
  for (const row of parsed) {
    const item = byName.get(row.fullName)
    if (!item) continue
    CACHE.set(cacheKeyFor(item), { at: Date.now(), intro: row.intro, onboarding: row.onboarding })
    result[row.fullName] = { intro: row.intro, onboarding: row.onboarding }
  }
  return result
}
