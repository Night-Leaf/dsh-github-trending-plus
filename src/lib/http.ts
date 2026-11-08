/**
 * Outbound text transport with a fallback chain.
 *
 * GitHub HTML endpoints are blocked or throttled on some networks while the
 * Harness host keeps a working route of its own. Instead of hard-coding one
 * transport, this module keeps an ordered chain of backends: plain `fetch()`,
 * DNS-over-HTTPS / candidate-IP dialling, the selected system proxy, then any
 * backend the Host half registers from `ctx.web`. The first backend that
 * answers wins; every failure is collected so the final error names each route
 * that was tried.
 *
 * @module @royalsan/dsh-github-trending/http
 */

import { isIP } from 'node:net'
import {
  ADDRESS_ATTEMPT_TIMEOUT_MS,
  ADDRESS_TOTAL_BUDGET_MS,
  DEFAULT_DOH_ENDPOINTS,
  DOH_ENDPOINT_TIMEOUT_MS,
  DOH_TOTAL_BUDGET_MS,
  candidateAddresses,
  cachedLocalProxyPorts,
  cachedSystemProxy,
  chooseProxy,
  directSkipReason,
  discoverLocalProxies,
  fetchLocalMitm,
  fetchViaAddresses,
  localProxyCacheReady,
  refreshSystemProxy,
  requestViaProxy,
  resolveDoh,
  systemProxyCacheReady,
} from './net.js'
import type { HostLookup, NetworkConfig, NetworkMode, NetRequestInit, NetResponse } from './net.js'
import { ensureCaPem } from './systemCa.js'

/** Per-request options shared by every backend. */
export interface TextInit {
  readonly headers?: Record<string, string>
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  /** Whole `fetchText` chain budget; defaults to the configured total budget (25000ms). */
  readonly budgetMs?: number
  /** Optional HTTP method; defaults to GET, keeps old callers working. */
  readonly method?: string
  /** Optional request body, only meaningful together with `method`. */
  readonly body?: string | Uint8Array
  /** Test seam for the pre-direct DNS check; defaults to the system lookup. */
  readonly dnsLookup?: HostLookup
  /** Test seam: CA provider for the local-mitm backend; defaults to systemCa.ensureCaPem. */
  readonly localMitmCa?: (host: string) => Promise<string | null>
  /** Test seam: local-mitm request implementation; defaults to net.fetchLocalMitm. */
  readonly localMitmFetch?: (
    url: string,
    ca: string,
    port?: number,
    init?: NetRequestInit,
  ) => Promise<NetResponse>
}

/** One answer from a backend. */
export interface TextResult {
  readonly status: number
  readonly text: string
  readonly url: string
  /** Backend id that produced the answer, useful in diagnostics. */
  readonly via: string
  /** True when the backend had to cut the body short. */
  readonly truncated?: boolean
  /** Number of backends tried before this answer (1 means the first one won). */
  readonly attempts: number
}

/** A transport a backend may provide. Throwing means "try the next backend". */
export type TextBackend = (url: string, init: TextInit) => Promise<TextResult>

const DEFAULT_TIMEOUT_MS = 20000
/** Whole chain budget: one report request may never spend more than this. */
export const DEFAULT_TOTAL_BUDGET_MS = 25000
/** Configured budget range the Host half clamps to. */
export const MIN_TOTAL_BUDGET_MS = 5000
export const MAX_TOTAL_BUDGET_MS = 25000
/** Per-backend cap; a hanging route leaves room inside the total budget. */
const DEFAULT_PER_ATTEMPT_MS = 6000
/** Never start another backend with less time than this left in the budget. */
const MIN_BACKEND_MS = 1500

/**
 * The built-in `fetch` resolves through the operating system's DNS. If the
 * embedding process replaced `globalThis.fetch` (tests, a transport shim), its
 * resolution rules are unknown, so the loopback DNS precheck would be guessing
 * and is skipped. The precheck only guards the native path it can reason about.
 */
const NATIVE_FETCH = globalThis.fetch

/** Runtime network options; replaced by `configureNetwork()` from the Host half. */
const NETWORK: {
  networkMode: NetworkMode
  proxyUrl: string
  dohEndpoints: string[]
  candidateIPs: Record<string, string[]>
  forceDirect: boolean
  caPath: string
  totalBudgetMs: number
} = {
  networkMode: 'auto',
  proxyUrl: '',
  dohEndpoints: [...DEFAULT_DOH_ENDPOINTS],
  candidateIPs: {},
  forceDirect: false,
  caPath: '',
  totalBudgetMs: DEFAULT_TOTAL_BUDGET_MS,
}

/**
 * Network options accepted from the Host config: the base transport fields plus
 * the egress v3 switches that only this module consumes.
 */
export interface NetworkSetupConfig extends NetworkConfig {
  /** Force the direct backend only; the loopback precheck is skipped as well. */
  readonly forceDirect?: boolean
  /** PEM cache path for the local accelerator CA; empty means `systemCa`'s default. */
  readonly caPath?: string
  /** Whole report fetch budget; the Host half clamps it to 5000-25000ms. */
  readonly totalBudgetMs?: number
}

/**
 * Apply the network configuration coming from `src/index.ts`. Unknown modes
 * fall back to `auto`; an empty `dohEndpoints` list restores the defaults.
 */
export function configureNetwork(config: NetworkSetupConfig = {}): void {
  const mode = String(config.networkMode ?? '').trim().toLowerCase()
  NETWORK.networkMode = mode === 'manual' || mode === 'off' ? mode : 'auto'
  NETWORK.proxyUrl = String(config.proxyUrl ?? '').trim()
  const endpoints = Array.isArray(config.dohEndpoints)
    ? config.dohEndpoints.map((value) => String(value ?? '').trim()).filter(Boolean)
    : []
  NETWORK.dohEndpoints = endpoints.length > 0 ? endpoints : [...DEFAULT_DOH_ENDPOINTS]
  const candidates: Record<string, string[]> = {}
  for (const [host, values] of Object.entries(config.candidateIPs ?? {})) {
    const key = String(host ?? '').trim().toLowerCase()
    if (!key) continue
    candidates[key] = (Array.isArray(values) ? values : []).map((value) => String(value ?? '').trim()).filter(Boolean)
  }
  NETWORK.candidateIPs = candidates
  // Forced direct wins over discovery: it never needs a registry read or a
  // local-port probe, and the chain builder below returns `direct` alone.
  NETWORK.forceDirect = config.forceDirect === true
  NETWORK.caPath = String(config.caPath ?? '').trim()
  const budget = Number(config.totalBudgetMs)
  NETWORK.totalBudgetMs = Number.isFinite(budget) && budget > 0 ? Math.round(budget) : DEFAULT_TOTAL_BUDGET_MS
}

/** Whole fetch budget currently in force; `report.ts` derives its window from it. */
export function currentTotalBudgetMs(): number {
  return NETWORK.totalBudgetMs
}

/** Configured PEM cache path for the local accelerator CA; empty means the default. */
export function currentCaPath(): string {
  return NETWORK.caPath
}

/** Snapshot of the active network options (tests and diagnostics). */
export function currentNetworkConfig(): NetworkConfig {
  return {
    networkMode: NETWORK.networkMode,
    proxyUrl: NETWORK.proxyUrl,
    dohEndpoints: [...NETWORK.dohEndpoints],
    candidateIPs: { ...NETWORK.candidateIPs },
  }
}

/**
 * Flatten an error and its `cause` chain into one actionable line, so a failed
 * outbound request reports its real reason instead of undici's bare
 * `fetch failed`.
 */
export function describeFetchError(error: unknown): string {
  const parts: string[] = []
  let current: any = error
  for (let depth = 0; current && depth < 5; depth += 1) {
    const message = typeof current.message === 'string' ? current.message : String(current)
    const code = typeof current.code === 'string' ? current.code : ''
    const detail = [
      code && !message.includes(code) ? `${message} [${code}]` : message,
      typeof current.errno === 'string' ? `errno=${current.errno}` : '',
      current.hostname ? `host=${current.hostname}` : '',
    ]
      .filter(Boolean)
      .join(' ')
      .trim()
    if (detail && !parts.includes(detail)) parts.push(detail)
    current = current.cause
  }
  return parts.join(' || ') || 'unknown error'
}

const FALLBACKS: { id: string; backend: TextBackend }[] = []

function linkedSignal(timeoutMs: number, outer?: AbortSignal): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
  const relay = () => controller.abort()
  if (outer) {
    if (outer.aborted) controller.abort()
    else outer.addEventListener('abort', relay, { once: true })
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      if (outer) outer.removeEventListener('abort', relay)
    },
  }
}

/**
 * Race one backend against its attempt deadline. The timer is always cleared,
 * and a backend that ignores its AbortSignal can no longer stretch the chain
 * past the remaining total budget.
 */
function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`backend timeout after ${timeoutMs}ms`)), Math.max(1, timeoutMs))
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** Plain `fetch()` — the default and usually fastest route. */
export const directBackend: TextBackend = async (url, init) => {
  const { signal, dispose } = linkedSignal(init.timeoutMs ?? DEFAULT_TIMEOUT_MS, init.signal)
  try {
    const response = await fetch(url, {
      method: init.method ?? 'GET',
      body: init.body as BodyInit | undefined,
      signal,
      headers: init.headers,
    })
    const text = await response.text()
    return { status: response.status, text, url, via: 'direct', attempts: 1 }
  } catch (error) {
    throw new Error(`direct fetch ${describeFetchError(error)}`, { cause: error })
  } finally {
    dispose()
  }
}

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
}

/**
 * Dial the real domain names to GitHub from the current session's network.
 * Candidate addresses are the DoH answer first (when it answers), then the
 * built-in / configured / `GITHUB_TRENDING_IP` fallbacks, retrying each one.
 */
const dohIpBackend: TextBackend = async (url, init) => {
  const target = new URL(url)
  const host = target.hostname
  const failures: string[] = []
  const addresses: string[] = []
  const remaining = Number.isFinite(Number(init.timeoutMs)) && Number(init.timeoutMs) > 0 ? Number(init.timeoutMs) : 8000
  try {
    const resolved = await resolveDoh(host, {
      endpoints: NETWORK.dohEndpoints,
      timeoutMs: Math.min(DOH_ENDPOINT_TIMEOUT_MS, Math.max(50, remaining)),
      totalBudgetMs: Math.min(DOH_TOTAL_BUDGET_MS, Math.max(100, remaining)),
      signal: init.signal,
    })
    for (const ip of resolved) if (!addresses.includes(ip)) addresses.push(ip)
  } catch (error) {
    failures.push(`doh: ${error instanceof Error ? error.message : String(error)}`)
  }
  for (const ip of candidateAddresses(host, NETWORK)) {
    if (!addresses.includes(ip)) addresses.push(ip)
  }
  try {
    const result = await fetchViaAddresses(url, addresses, init, {
      timeoutMs: ADDRESS_ATTEMPT_TIMEOUT_MS,
      totalBudgetMs: Math.min(ADDRESS_TOTAL_BUDGET_MS, Math.max(100, remaining)),
    })
    return { ...result, via: 'doh-ip', attempts: 1 }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  }
  throw new Error(
    `no address for ${host} answered (${failures.length > 0 ? failures.join('; ') : 'no candidate addresses'})`,
  )
}

/** Forward one request through the selected HTTP proxy (CONNECT tunnel). */
const proxyBackend: TextBackend = async (url, init) => {
  const decision = chooseProxy(url, process.env, NETWORK)
  if (decision.mode !== 'proxy' || !decision.proxy) throw new Error(`no proxy selected (${decision.source})`)
  try {
    const result = await requestViaProxy(url, decision.proxy, init)
    return { ...result, via: 'proxy', attempts: 1 }
  } catch (error) {
    throw new Error(`proxy ${decision.proxy} ${describeFetchError(error)}`, { cause: error })
  }
}

/** Forward one request through the system proxy read from the registry. */
const systemProxyBackend: TextBackend = async (url, init) => {
  const info = cachedSystemProxy()
  if (!info?.url) throw new Error('no system proxy discovered')
  try {
    const result = await requestViaProxy(url, info.url, init)
    return { ...result, via: 'system-proxy', attempts: 1 }
  } catch (error) {
    throw new Error(`system proxy ${info.url} ${describeFetchError(error)}`, { cause: error })
  }
}

/** One fixed local proxy port; discovery already proved it answers CONNECT 2xx. */
function localProxyBackend(port: number): TextBackend {
  return async (url, init) => {
    const proxyUrl = `http://127.0.0.1:${port}`
    try {
      const result = await requestViaProxy(url, proxyUrl, init)
      return { ...result, via: `local-proxy-${port}`, attempts: 1 }
    } catch (error) {
      throw new Error(`local proxy ${proxyUrl} ${describeFetchError(error)}`, { cause: error })
    }
  }
}

/** Local port of the TLS-intercepting accelerator (Steam++ and friends). */
const LOCAL_MITM_PORT = 443

/**
 * Verification failures that a fresh export can cure: the accelerator rotated
 * or reinstalled its root, so the PEM cache is stale. A hostname mismatch is
 * excluded — exporting the same root again cannot fix it.
 */
function isCertificateError(error: unknown): boolean {
  const code = String((error as any)?.code ?? '')
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return false
  if (/^(UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_)/.test(code)) {
    return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return /unable to verify|self[- ]signed|certificate has expired|certificate is not yet valid/i.test(message)
}

/**
 * One request through a local TLS-intercepting accelerator.
 *
 * The CA is resolved here and passed **only** to `fetchLocalMitm`; the shared
 * `init` handed to direct / doh-ip / proxy never carries it. When no matching
 * root can be exported the backend reports a skip-style failure and the chain
 * moves on instead of throwing out of `fetchText`.
 */
const localMitmBackend: TextBackend = async (url, init) => {
  const host = new URL(url).hostname
  const provider = init.localMitmCa
  const send = init.localMitmFetch ?? fetchLocalMitm
  const caPath = NETWORK.caPath
  let ca = provider
    ? await provider(host)
    : await ensureCaPem(host, caPath ? { cachePath: caPath } : {})
  if (!ca) throw new Error('no matching system CA for the local accelerator')
  try {
    const result = await send(url, ca, LOCAL_MITM_PORT, init)
    return { ...result, via: 'local-mitm', attempts: 1 }
  } catch (error) {
    // The cached PEM may belong to a replaced root: drop it, export once more
    // and retry exactly one time (the plan's "TLS failure once" rule).
    if (provider || !isCertificateError(error)) throw error
    const refreshed = await ensureCaPem(host, caPath ? { force: true, cachePath: caPath } : { force: true })
    if (!refreshed) throw error
    const result = await send(url, refreshed, LOCAL_MITM_PORT, init)
    return { ...result, via: 'local-mitm', attempts: 1 }
  }
}

/**
 * Append a fallback transport. Returns a disposer that removes it again, so the
 * Host can clean up when its plugin context goes away.
 */
export function registerTextBackend(id: string, backend: TextBackend): () => void {
  const entry = { id, backend }
  FALLBACKS.push(entry)
  return () => {
    const index = FALLBACKS.indexOf(entry)
    if (index >= 0) FALLBACKS.splice(index, 1)
  }
}

/**
 * Fill the synchronous chain builder with the asynchronous facts it needs: the
 * system proxy from the registry and the local proxy ports that answer CONNECT.
 * Both reads are TTL-cached in `net.ts`, so a burst of report requests pays for
 * at most one registry read and one probe round.
 */
async function ensureEgressDiscovery(): Promise<void> {
  // A forced direct request has no proxy / MITM backend to discover.
  if (NETWORK.forceDirect) return
  if (NETWORK.networkMode === 'off') return
  const pending: Promise<unknown>[] = []
  if (!systemProxyCacheReady()) pending.push(refreshSystemProxy())
  if (!localProxyCacheReady()) pending.push(discoverLocalProxies())
  if (pending.length > 0) await Promise.all(pending)
}

function buildChain(
  url: string,
  options: { loopback?: boolean } = {},
): { id: string; backend: TextBackend }[] {
  // Explicit routing overrides discovery. Forced direct is one backend and no
  // loopback precheck; manual keeps exactly the configured proxy, so a running
  // system proxy can never appear in that chain.
  if (NETWORK.forceDirect) return [{ id: 'direct', backend: directBackend }]
  if (NETWORK.networkMode === 'manual' && NETWORK.proxyUrl) {
    return [{ id: 'proxy', backend: proxyBackend }]
  }
  const chain: { id: string; backend: TextBackend }[] = []
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    host = ''
  }
  // Proxies only make sense for a remote host; an IP literal or a local name is
  // dialled directly (the loopback / test path).
  const remote = NETWORK.networkMode !== 'off' && host !== '' && isIP(host) === 0 && !isLocalHost(host)
  const system = remote ? cachedSystemProxy() : null
  if (system?.url) chain.push({ id: 'system-proxy', backend: systemProxyBackend })
  if (remote) {
    for (const port of cachedLocalProxyPorts()) {
      chain.push({ id: `local-proxy-${port}`, backend: localProxyBackend(port) })
    }
  }
  // A real host name that resolves to loopback is the accelerator's MITM
  // listener. Keep it after the proxies (a working system proxy wins when both
  // are on) and before direct, which the precheck already marked as doomed.
  if (remote && options.loopback) chain.push({ id: 'local-mitm', backend: localMitmBackend })
  chain.push({ id: 'direct', backend: directBackend })
  if (remote) {
    chain.push({ id: 'doh-ip', backend: dohIpBackend })
    const decision = chooseProxy(url, process.env, NETWORK)
    // A system proxy has its own backend above; do not try it twice.
    if (decision.mode === 'proxy' && decision.proxy && decision.source !== 'system') {
      chain.push({ id: 'proxy', backend: proxyBackend })
    }
  }
  chain.push(...FALLBACKS)
  return chain
}

/** Backend ids in the order they are tried for `url`, for diagnostics. */
export function textBackendIds(url = 'https://github.com/'): string[] {
  return buildChain(url).map((entry) => entry.id)
}

/**
 * Fetch one URL as text, trying each backend in order. Resolves with the first
 * answer (including non-2xx: the caller decides), throws only when every
 * backend failed. The answer records the winning `via` and the number of
 * `attempts`, so callers can report which route was used.
 */
export async function fetchText(url: string, init: TextInit = {}): Promise<TextResult> {
  const failures: string[] = []
  await ensureEgressDiscovery()
  const requested = Number(init.timeoutMs)
  const perAttempt =
    Number.isFinite(requested) && requested > 0 ? Math.min(requested, DEFAULT_PER_ATTEMPT_MS) : DEFAULT_PER_ATTEMPT_MS
  const requestedBudget = Number(init.budgetMs)
  const totalBudget =
    Number.isFinite(requestedBudget) && requestedBudget > 0 ? requestedBudget : NETWORK.totalBudgetMs
  const startedAt = Date.now()
  // Precheck direct before building the chain. A real host name that resolves
  // to loopback means the local accelerator is intercepting: direct is doomed,
  // and the local-mitm backend (which needs that loopback fact) joins the chain
  // before direct. A replaced global fetch resolves by its own rules, so it is
  // left alone unless the caller provides an explicit `dnsLookup`.
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    host = ''
  }
  const customFetch = typeof globalThis.fetch === 'function' && globalThis.fetch !== NATIVE_FETCH
  const canPrecheck = typeof init.dnsLookup === 'function' || !customFetch
  // A forced direct request must try `direct` even when the name resolves to
  // loopback (the local accelerator case), so the precheck is skipped entirely
  // instead of marking direct as doomed and leaving an empty chain.
  const loopback =
    !NETWORK.forceDirect && host && canPrecheck ? await directSkipReason(host, { lookup: init.dnsLookup }) : null
  const chain = buildChain(url, { loopback: Boolean(loopback) })
  let skipDirect = false
  if (loopback) {
    skipDirect = true
    failures.push(`direct: skipped (${loopback})`)
  }
  let attempts = 0
  for (const entry of chain) {
    if (entry.id === 'direct' && skipDirect) continue
    const remaining = totalBudget - (Date.now() - startedAt)
    if (remaining < MIN_BACKEND_MS) {
      failures.push(`${entry.id}: skipped, only ${Math.max(0, remaining)}ms left in the budget`)
      continue
    }
    attempts += 1
    const attemptTimeout = Math.max(1, Math.min(perAttempt, remaining))
    const { signal, dispose } = linkedSignal(attemptTimeout, init.signal)
    try {
      const result = await withDeadline(
        entry.backend(url, { ...init, timeoutMs: attemptTimeout, signal }),
        attemptTimeout,
      )
      if (typeof result.text === 'string') {
        return { ...result, via: result.via || entry.id, attempts }
      }
      failures.push(`${entry.id}: empty body`)
    } catch (error) {
      failures.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      dispose()
    }
  }
  const elapsed = Math.max(0, Date.now() - startedAt)
  throw new Error(`no transport could load ${url} (${failures.join('; ')}) after ${elapsed}ms`)
}
