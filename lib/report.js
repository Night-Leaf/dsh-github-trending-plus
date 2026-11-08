// Generated from src/lib/report.ts - do not edit by hand; run `node build.mjs`.
/**
 * Report orchestration: scrape -> enrich -> analyse -> render, with a small
 * in-process cache so the panel, the `/github-trending` command and the tool can
 * share one fetch and the network is hit at most once per TTL window.
 */

import { analyzeRepos } from './analyze.js'
                                                
import { CATEGORY_CATALOG } from './categories.js'
                                                   
import { addApiCalls, apiCallsMade, enrichRepos, resetApiCalls } from './enrich.js'
import { currentTotalBudgetMs } from './http.js'
import { buildMermaid, buildSummary } from './render.js'
                                                              
import { fetchTrendingSet, lastFetchVia, normalizeSince, resetFetchVia, slugForLanguage } from './trending.js'
                                                                                 

/** How the transport reached GitHub for the last successful fetch in this report. */
                                                          

/** A user-defined chip: a label plus up to 20 keywords matched on merged card text. */
                              
             
               
                    
 

                                                

/** One failed trending-fetch attempt, surfaced so the panel can explain the retry. */
                                
                                
                          
                                            
                     
                                                                                  
                            
 

/** Failure payload carried inside a 200 response so the panel can say what broke. */
                              
                           
                                                                                
                         
                                                    
                                              
 

                                
                 
                    
                 
                      
                   
                       
                      
                    
                                                                                     
                       
                                                                                
                       
                                                                                    
                        
                                                                                        
                          
                                                             
                     
                                                                                   
                           
                                                                                     
                        
 

                                 
                      
                         
                     
                       
                        
                         
                    
                        
                    
                   
                                                           
                  
                                                                                  
                       
                 
                              
                                                                               
                     
                                                                             
                         
                                              
                             
                                                                       
                   
                                                                                               
                                
 

const MAX_CUSTOM_BOARDS = 6
const MAX_BOARD_KEYWORDS = 20

export function normalizeCustomBoards(value         )                {
  if (!Array.isArray(value)) return []
  const boards                = []
  for (const item of value.slice(0, MAX_CUSTOM_BOARDS)) {
    if (!item || typeof item !== 'object') continue
    const record = item                           
    const keywords = Array.isArray(record.keywords)
      ? record.keywords
          .map((keyword) => String(keyword ?? '').trim())
          .filter(Boolean)
          .slice(0, MAX_BOARD_KEYWORDS)
      : []
    const label = String(record.label ?? record.zh ?? record.en ?? record.key ?? '').trim()
    if (!label) continue
    const key = String(record.key ?? '').trim() || `custom-${boards.length + 1}`
    boards.push({ key, label, keywords })
  }
  return boards
}

export function normalizeInstallQuality(value         )                 {
  return String(value ?? '').trim().toLowerCase() === 'degraded' ? 'degraded' : 'pass'
}

const CACHE_TTL_MS = 10 * 60 * 1000
/** One automatic retry after a network error, so a transient blip is invisible. */
const REPORT_MAX_ATTEMPTS = 2
/** Pause before the retry; the first attempt leaves room for both. */
const REPORT_RETRY_DELAY_MS = 1500
/** Never start an attempt with less time than this left in the window. */
const MIN_RETRY_ATTEMPT_MS = 500
/** Margin kept below the transport budget so timer latency cannot stretch it. */
const REPORT_WINDOW_MARGIN_MS = 250
const CACHE = new Map                                                ()
const INFLIGHT = new Map                                 ()

export function clearReportCache()       {
  CACHE.clear()
}

function clampInt(value         , fallback        , min        , max        )         {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

/**
 * The wall-clock window one report may spend on its trending fetch. The
 * transport owns the total budget (`totalBudgetMs`, default 25000ms); the
 * window is that budget minus a small margin, so a 25s budget cannot turn into
 * a 25.1s wait. A caller-supplied `timeoutMs` may only shorten it.
 */
export function reportFetchWindowMs(timeoutMs          )         {
  const totalBudget = currentTotalBudgetMs()
  const requested = Number(timeoutMs)
  const cap = Number.isFinite(requested) && requested > 0 ? Math.min(requested, totalBudget) : totalBudget
  return cap > 1000 ? cap - REPORT_WINDOW_MARGIN_MS : cap
}

function truthy(value         )          {
  if (value === true) return true
  const raw = String(value ?? '').toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

function cacheKey(
  since               ,
  language               ,
  limit        ,
  focusCount        ,
  enriched         ,
)         {
  return `${since}|${language ?? '*'}|${limit}|${focusCount}|${enriched ? 'enriched' : 'snapshot'}`
}

export function reportQuery(options               )                                                                                       {
  const since = normalizeSince(options.since)
  const language = slugForLanguage(options.language) || null
  const limit = clampInt(options.limit, 50, 3, 50)
  const focusCount = clampInt(options.focusCount, 3, 1, 6)
  return { since, language, limit, focusCount }
}

/** Map the last successful backend id onto the three-value network status. */
export function networkStatusFor(lastVia        )                {
  const via = String(lastVia ?? '').trim()
  if (!via) return 'fail'
  // The user's own exit — a system proxy or a local accelerator — is not a
  // degradation: it is how that machine reaches GitHub. Only the plugin's own
  // DoH / fixed-IP / manual-proxy fallbacks count as "fallback".
  if (via === 'direct' || via === 'local-mitm' || via === 'system-proxy' || via.startsWith('local-proxy')) {
    return 'direct'
  }
  return 'fallback'
}

/**
 * Build the structural payload returned when the trending fetch fails: same
 * shape as a normal report, empty data, and a top-level `error` the panel can
 * render. It is intentionally never written to `CACHE`.
 */
function failureReport(
  options               ,
  since               ,
  language               ,
  limit        ,
  focusCount        ,
  startedAt        ,
  detail        ,
  attempts                           = [],
)                 {
  const summary = buildSummary([])
  return {
    since,
    language,
    generatedAt: new Date().toISOString(),
    repos: [],
    summary,
    mermaid: buildMermaid([], summary),
    focusCount,
    cache: 'fresh',
    durationMs: Date.now() - startedAt,
    shortfall: limit,
    shortfallReason: 'network-error',
    apiCalls: apiCallsMade(),
    enrichedCount: 0,
    lastVia: lastFetchVia(),
    networkStatus: 'fail',
    catalog: CATEGORY_CATALOG,
    customBoards: normalizeCustomBoards(options.customBoards),
    deepCount: clampInt(options.deepCount, 10, 1, 50),
    installQuality: normalizeInstallQuality(options.installQuality),
    error: { class: 'network', detail, attempts: [...attempts] },
  }
}

/**
 * Turn the transport's combined error text into one summary per backend, so
 * `error.attempts` can name what failed instead of only echoing one blob.
 */
export function summarizeAttemptReasons(message        )           {
  const text = String(message ?? '').trim()
  if (!text) return []
  const inner = /no transport could load .*? \(([\s\S]*)\) after \d+ms$/i.exec(text)
  const body = inner ? inner[1] : text
  const parts = body
    .split(/;\s+(?=[a-z][a-z0-9-]*:\s)/i)
    .map((part) => part.trim())
    .filter(Boolean)
  return parts.length > 0 ? parts : [text]
}

/** Wait `ms` before the retry attempt. */
function sleep(ms        )                {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms))
  })
}

/**
 * Divide the remaining fetch window between the two attempts. The first
 * attempt leaves room for the retry delay plus a useful second attempt, so two
 * full 25s attempts can never happen.
 */
function attemptBudget(remainingMs        , attempt        , retryDelayMs        )         {
  if (attempt >= REPORT_MAX_ATTEMPTS) return Math.max(1, Math.floor(remainingMs))
  const available = Math.max(0, remainingMs - retryDelayMs)
  const share = available / 2
  if (share <= MIN_RETRY_ATTEMPT_MS) return Math.max(1, Math.floor(share))
  return Math.max(MIN_RETRY_ATTEMPT_MS, Math.floor(available * 0.55))
}

export async function getReport(options                = {})                          {
  const { since, language, limit, focusCount } = reportQuery(options)
  // The tier is part of the cache identity, so a snapshot request and a full
  // request never read or overwrite each other's payload. The read, write and
  // inflight-delete calls below all use this one key.
  const enrichCount = clampInt(options.enrichCount, options.token ? limit : 10, 0, limit)
  const readmeCount = clampInt(options.readmeCount, options.token ? limit : 10, 0, limit)
  const key = cacheKey(since, language, limit, focusCount, enrichCount > 0)
  const now = Date.now()

  if (!truthy(options.refresh)) {
    const cached = CACHE.get(key)
    if (cached && now - cached.at < CACHE_TTL_MS) {
      return { ...cached.report, cache: 'hit' }
    }
    const inflight = INFLIGHT.get(key)
    if (inflight) return inflight
  }

  const task = (async ()                          => {
    const started = Date.now()
    resetApiCalls()
    resetFetchVia()
    // One wall-clock deadline for the whole report task: the trending fetch
    // gets the configured budget window, and enrichment must stop at the same
    // instant instead of adding another 20s budget of its own.
    const controller = new AbortController()
    const outerSignal = options.signal
    const relayAbort = ()       => controller.abort()
    if (outerSignal) {
      if (outerSignal.aborted) controller.abort()
      else outerSignal.addEventListener('abort', relayAbort, { once: true })
    }
    // Fire 250ms before the nominal budget so timer/event-loop latency does not
    // turn a 25s budget into a 25.1s wait. Small test budgets keep their value.
    const trendingDeadlineMs = reportFetchWindowMs(options.timeoutMs)
    const overallDeadlineMs = reportFetchWindowMs()
    const overallTimer = setTimeout(() => controller.abort(), Math.max(1, overallDeadlineMs))
    const retryDelaySetting = Number(options.retryDelayMs)
    const retryDelayMs =
      Number.isFinite(retryDelaySetting) && retryDelaySetting >= 0
        ? Math.min(5000, retryDelaySetting)
        : REPORT_RETRY_DELAY_MS
    const fetchWindowEnd = started + Math.max(1, trendingDeadlineMs)
    const attempts                  = []
    let trending                                                      = null
    let lastError = ''

    for (let index = 0; index < REPORT_MAX_ATTEMPTS; index += 1) {
      const attemptNo = index + 1
      if (index > 0) {
        const waitMs = Math.min(retryDelayMs, Math.max(0, fetchWindowEnd - Date.now() - MIN_RETRY_ATTEMPT_MS))
        if (waitMs > 0) await sleep(waitMs)
        if (controller.signal.aborted) break
      }
      const remaining = fetchWindowEnd - Date.now()
      if (remaining < MIN_RETRY_ATTEMPT_MS) break
      const budget = attemptBudget(remaining, attemptNo, retryDelayMs)
      const attemptStarted = Date.now()
      const attemptController = new AbortController()
      const relayAbortAttempt = ()       => attemptController.abort()
      if (controller.signal.aborted) attemptController.abort()
      else controller.signal.addEventListener('abort', relayAbortAttempt, { once: true })
      let attemptTimer                                           
      const deadline = new Promise       ((_resolve, reject) => {
        attemptTimer = setTimeout(() => {
          attemptController.abort()
          reject(new Error(`trending fetch timed out after ${budget}ms`))
        }, Math.max(1, budget))
      })
      try {
        trending = await Promise.race([
          fetchTrendingSet({
            since,
            language,
            target: limit,
            fetchBoard: options.fetchBoard,
            signal: attemptController.signal,
            timeoutMs: budget,
          }),
          deadline,
        ])
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        attempts.push({
          attempt: attemptNo,
          ms: Date.now() - attemptStarted,
          reasons: summarizeAttemptReasons(lastError),
        })
      } finally {
        if (attemptTimer) clearTimeout(attemptTimer)
        controller.signal.removeEventListener('abort', relayAbortAttempt)
      }
      if (trending) break
      if (controller.signal.aborted) break
    }

    if (!trending) {
      const duration = Date.now() - started
      clearTimeout(overallTimer)
      if (outerSignal) outerSignal.removeEventListener('abort', relayAbort)
      const tried = attempts.length > 0 ? attempts.length : 1
      return failureReport(
        options,
        since,
        language,
        limit,
        focusCount,
        started,
        `抓取 GitHub Trending 失败（已尝试 ${tried} 次，耗时 ${duration} ms）：${lastError || 'network-error'}`,
        attempts,
      )
    }
    const sliced = trending.repos.slice(0, limit)
    const remainingMs = Math.max(0, reportFetchWindowMs() - (Date.now() - started))
    // Less than 2s left: enrich nothing rather than start a request that would
    // outlive the report deadline.
    const enrichmentBudgetMs = Math.max(0, remainingMs - 500)
    const enrichment = await enrichRepos(sliced, {
      token: options.token,
      enrichCount: remainingMs < 2000 ? 0 : enrichCount,
      readmeCount: remainingMs < 2000 ? 0 : Math.min(readmeCount, enrichCount),
      concurrency: 6,
      budgetMs: Math.max(2000, enrichmentBudgetMs),
      signal: controller.signal,
    })
    clearTimeout(overallTimer)
    if (outerSignal) outerSignal.removeEventListener('abort', relayAbort)
    // The report keeps the Task-2 counter authoritative and accumulates what
    // this enrichment run actually issued instead of overwriting it.
    addApiCalls(enrichment.apiCalls)
    const repos = analyzeRepos(sliced, enrichment.facts, { since, focusCount })
    const generatedAt = new Date().toISOString()
    const summary = buildSummary(repos)
    const mermaid = buildMermaid(repos, summary)
    const lastVia = lastFetchVia()
    const customBoards = normalizeCustomBoards(options.customBoards)
    const deepCount = clampInt(options.deepCount, 10, 1, 50)
    const report                 = {
      since,
      language,
      generatedAt,
      repos,
      summary,
      mermaid,
      focusCount,
      cache: 'fresh',
      durationMs: Date.now() - started,
      shortfall: trending.shortfall,
      shortfallReason: trending.shortfallReason,
      apiCalls: apiCallsMade(),
      enrichedCount: enrichment.enrichedCount,
      lastVia,
      networkStatus: networkStatusFor(lastVia),
      catalog: CATEGORY_CATALOG,
      customBoards,
      deepCount,
      installQuality: normalizeInstallQuality(options.installQuality),
    }
    CACHE.set(key, { at: Date.now(), report })
    return report
  })()

  INFLIGHT.set(key, task)
  try {
    return await task
  } finally {
    INFLIGHT.delete(key)
  }
}