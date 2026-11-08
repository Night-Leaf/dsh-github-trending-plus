/**
 * Network primitives used by the outbound transport:
 *
 *   - `resolveDoh(host)`            : resolve A records through Cloudflare /
 *                                     Google DNS-over-HTTPS JSON endpoints.
 *   - `candidateAddresses(host, c)` : built-in + configured + `GITHUB_TRENDING_IP`
 *                                     fallback addresses, de-duplicated.
 *   - `chooseProxy(url, env, c)`    : auto / manual / off proxy selection with
 *                                     `HTTPS_PROXY` and `NO_PROXY` support.
 *   - `fetchViaAddress(url, ip)`    : request one host while dialling a fixed
 *                                     address (Host / SNI stay the real host).
 *   - `fetchLocalMitm(url, ca)`     : dial `127.0.0.1:443` while keeping the
 *                                     real SNI and certificate verification.
 *   - `requestViaProxy(url, proxy)` : minimal HTTP CONNECT tunnel.
 *
 * Only Node built-ins are used; no third-party dependency is added.
 *
 * @module @royalsan/dsh-github-trending/net
 */

import { execFile } from 'node:child_process'
import { lookup as dnsLookup } from 'node:dns'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as netConnect, isIP, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'

/** Proxy policy: `auto` reads the environment, `manual` uses config, `off` direct only. */
export type NetworkMode = 'auto' | 'manual' | 'off'

/** Network options handed down from the Host half. */
export interface NetworkConfig {
  readonly networkMode?: NetworkMode
  readonly proxyUrl?: string
  readonly dohEndpoints?: string[]
  readonly candidateIPs?: Record<string, string[]>
}

/** Per-request knobs shared with `http.ts`. */
export interface NetRequestInit {
  readonly method?: string
  readonly headers?: Record<string, string>
  readonly body?: string | Uint8Array
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly rejectUnauthorized?: boolean
  /** PEM string (or list) added to the trust store of an https request. */
  readonly ca?: string | string[]
}

/** One completed outbound response. */
export interface NetResponse {
  readonly status: number
  readonly text: string
  readonly url: string
  /** Backend id that produced this answer. */
  readonly via: string
}

/**
 * Default DoH endpoints, in priority order: the two JSON APIs reachable from
 * mainland China first, the historical Cloudflare / Google fallbacks after.
 * Each template is expanded by `dohEndpointUrl()`; all four answer with the
 * same `Answer[].data` shape.
 */
export const DEFAULT_DOH_ENDPOINTS: readonly string[] = [
  'https://dns.alidns.com/resolve?name={host}&type=A',
  'https://doh.pub/dns-query?name={host}&type=A',
  'https://1.1.1.1/dns-query?name={host}&type=A',
  'https://8.8.8.8/resolve?name={host}&type=A',
]

/** Per-endpoint DoH timeout (one resolver request may not exceed this). */
export const DOH_ENDPOINT_TIMEOUT_MS = 2500
/** Whole DoH round budget: four dead endpoints must not add up to 10s. */
export const DOH_TOTAL_BUDGET_MS = 5000
/** Per-address direct-dial timeout inside one candidate round. */
export const ADDRESS_ATTEMPT_TIMEOUT_MS = 4000
/** Whole candidate-address round budget, independent of address count. */
export const ADDRESS_TOTAL_BUDGET_MS = 12000
/** A DNS precheck may spend at most this long before deciding to keep direct. */
export const DNS_PRECHECK_TIMEOUT_MS = 1000

/**
 * Race one operation against its budget. A fake socket / fetch that never
 * settles and ignores AbortSignal still cannot hold the caller past the
 * deadline; the timer is always cleared so Node exits cleanly.
 */
function withDeadline<T>(promise: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (onTimeout) onTimeout()
      reject(new Error(`timeout after ${timeoutMs}ms`))
    }, Math.max(1, timeoutMs))
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

/**
 * A DNS lookup returning every address for one host. The transport and tests
 * both use this shape; the default asks the operating system via `dns.lookup`.
 */
export type HostLookup = (host: string) => Promise<readonly string[]>

const defaultHostLookup: HostLookup = (host) =>
  new Promise((resolve, reject) => {
    dnsLookup(host, { all: true }, (error, addresses) => {
      if (error) reject(error)
      else resolve((addresses ?? []).map((entry) => String(entry.address ?? '')))
    })
  })

/**
 * True for an address that can never be a real GitHub endpoint: loopback
 * (`127.0.0.0/8`, `::1`), RFC 1918 private ranges, link-local and IPv6 ULA.
 * A host resolving here means TLS through the direct backend is doomed, so the
 * chain can skip it instead of burning its budget on a failed handshake.
 */
export function isNonPublicAddress(ip: string): boolean {
  const value = String(ip ?? '').trim().toLowerCase()
  const family = isIP(value)
  if (family === 4) {
    const parts = value.split('.').map(Number)
    if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return false
    if (parts[0] === 127 || parts[0] === 10) return true
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
    if (parts[0] === 192 && parts[1] === 168) return true
    if (parts[0] === 169 && parts[1] === 254) return true
    return false
  }
  if (family === 6) {
    if (value === '::1') return true
    if (/^f[cd][0-9a-f]{2}:/.test(value)) return true
    if (/^fe[89ab][0-9a-f]:/.test(value)) return true
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value)
    if (mapped) return isNonPublicAddress(mapped[1])
    return false
  }
  return false
}

export interface DirectPrecheckOptions {
  /** Test seam: replace the operating-system lookup. */
  readonly lookup?: HostLookup
  /** Upper bound for the precheck; defaults to {@link DNS_PRECHECK_TIMEOUT_MS}. */
  readonly timeoutMs?: number
}

/**
 * Quick DNS precheck before starting the direct backend.
 *
 * Returns the reason to skip direct when the host resolves to a loopback /
 * private address, or `null` when direct should be attempted. A lookup error
 * or timeout never skips direct: trying once is cheaper than a false negative.
 * IP literals and local host names are left alone (the test/loopback path).
 */
export async function directSkipReason(
  host: string,
  options: DirectPrecheckOptions = {},
): Promise<string | null> {
  const target = String(host ?? '').trim().toLowerCase().replace(/\.$/, '')
  if (!target || isIP(target) !== 0) return null
  if (target === 'localhost' || target.endsWith('.localhost') || target.endsWith('.local')) return null
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1, Number(options.timeoutMs))
    : DNS_PRECHECK_TIMEOUT_MS
  const lookup = options.lookup ?? defaultHostLookup
  try {
    const addresses = await withDeadline(Promise.resolve(lookup(target)), timeoutMs)
    const list = Array.isArray(addresses) ? addresses : []
    if (list.some((address) => isNonPublicAddress(String(address ?? '')))) return 'dns resolves to loopback'
  } catch {
    // Timeout or lookup error: keep direct in the chain, per the "try once" rule.
  }
  return null
}

const BUILTIN_ADDRESSES: Record<string, readonly string[]> = {
  'github.com': ['20.205.243.166', '140.82.112.3', '140.82.113.3', '140.82.114.3', '140.82.116.3', '140.82.121.3'],
  'api.github.com': ['20.205.243.168', '140.82.112.6', '140.82.113.6', '140.82.114.6', '140.82.116.6'],
  'codeload.github.com': ['20.205.243.165'],
  'raw.githubusercontent.com': ['185.199.108.133', '185.199.109.133', '185.199.110.133', '185.199.111.133'],
  'objects.githubusercontent.com': ['185.199.108.133', '185.199.109.133', '185.199.110.133', '185.199.111.133'],
}

/** Addresses from `GITHUB_TRENDING_IP` (comma or space separated) act as candidates. */
function environmentAddresses(): string[] {
  const raw = String(process.env.GITHUB_TRENDING_IP ?? '')
  return raw
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter((value) => isIP(value) !== 0)
}

/** Case-insensitive host pattern match: exact, `*.example.com` or `*`. */
function matchesHostPattern(host: string, pattern: string): boolean {
  const value = String(pattern ?? '').trim().toLowerCase().replace(/\.$/, '')
  if (!value) return false
  if (value === '*') return true
  if (value.startsWith('*.')) {
    const suffix = value.slice(1)
    return host.endsWith(suffix)
  }
  return host === value || (value.startsWith('.') ? host.endsWith(value) : host.endsWith(`.${value}`))
}

/**
 * Every address worth dialling for `host`: built-ins first, then the
 * `GITHUB_TRENDING_IP` fallback, then configured candidates. Order is kept,
 * duplicates and invalid values are dropped.
 */
export function candidateAddresses(host: string, config: NetworkConfig = {}): string[] {
  const key = String(host ?? '').trim().toLowerCase().replace(/\.$/, '')
  const out: string[] = []
  const push = (value: unknown): void => {
    const ip = String(value ?? '').trim()
    if (isIP(ip) && !out.includes(ip)) out.push(ip)
  }
  for (const ip of BUILTIN_ADDRESSES[key] ?? []) push(ip)
  if (key === 'github.com' || key.endsWith('.github.com')) {
    for (const ip of environmentAddresses()) push(ip)
  }
  const configured = config.candidateIPs ?? {}
  for (const [pattern, values] of Object.entries(configured)) {
    if (!matchesHostPattern(key, pattern)) continue
    for (const ip of Array.isArray(values) ? values : []) push(ip)
  }
  return out
}

function normalizeMode(mode: unknown): NetworkMode {
  const value = String(mode ?? '').trim().toLowerCase()
  return value === 'manual' || value === 'off' ? value : 'auto'
}

function readEnv(env: Record<string, string | undefined>, ...names: string[]): string {
  for (const name of names) {
    const value = env?.[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  // Environments on some platforms expose lower-case names only.
  for (const name of names) {
    const lower = name.toLowerCase()
    if (lower === name) continue
    const value = env?.[lower]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function splitHostPort(value: string, defaultPort: string): { host: string; port: string } | null {
  let text = value.trim().toLowerCase()
  if (!text) return null
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  text = text.split('/')[0].replace(/\.$/, '')
  if (!text) return null
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    if (end < 0) return null
    const host = text.slice(1, end)
    const rest = text.slice(end + 1)
    return { host, port: rest.startsWith(':') ? rest.slice(1) : defaultPort }
  }
  const colons = (text.match(/:/g) ?? []).length
  if (colons === 1) {
    const [host, port] = text.split(':')
    return { host, port: port || defaultPort }
  }
  if (colons > 1) return { host: text, port: defaultPort }
  return { host: text, port: defaultPort }
}

/** True when `NO_PROXY` says the target must bypass the proxy. */
export function noProxyMatches(host: string, port: string, noProxy: string): boolean {
  const target = String(host ?? '').trim().toLowerCase().replace(/\.$/, '')
  if (!target) return false
  const effectivePort = String(port ?? '').trim() || '443'
  for (const raw of String(noProxy ?? '').split(/[,\s]+/)) {
    const entry = raw.trim()
    if (!entry) continue
    if (entry === '*') return true
    const parsed = splitHostPort(entry, effectivePort)
    if (!parsed) continue
    if (parsed.port && parsed.port !== '*' && parsed.port !== effectivePort) continue
    // `.example.com` and `*.example.com` are both common suffix notations.
    const entryHost = parsed.host.replace(/^(\*?\.)/, '')
    if (entryHost === '*') return true
    if (!entryHost) continue
    if (target === entryHost) return true
    if (target.endsWith(`.${entryHost}`)) return true
  }
  return false
}

/** Registry key that holds the per-user WinINET proxy settings. */
export const SYSTEM_PROXY_REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/** System proxy parsed from the Windows registry. */
export interface SystemProxyInfo {
  readonly url: string
  readonly source: 'system'
  /** Raw `ProxyOverride` value: the semicolon-separated bypass list. */
  readonly bypass: string
}

/** Test seam: run one executable and resolve its stdout. */
export type RegExec = (file: string, args: readonly string[]) => Promise<{ readonly stdout: string }>

export interface SystemProxyOptions {
  /** Test seam: replace the real `reg.exe` invocation. */
  readonly execFile?: RegExec
  /** Test seam: replace `process.platform`. */
  readonly platform?: string
}

const defaultRegExec: RegExec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: 'utf8', timeout: 2000, windowsHide: true },
      (error: Error | null, stdout: string) => {
        if (error) reject(error)
        else resolve({ stdout: String(stdout ?? '') })
      },
    )
  })

/** Pull one `NAME REG_TYPE VALUE` row out of `reg query` output. */
function regValue(output: string, name: string): string | null {
  const pattern = new RegExp(`^\\s*${name}\\s+REG_[A-Z_]+\\s+(.*?)\\s*$`, 'm')
  const match = pattern.exec(String(output ?? ''))
  return match ? match[1] : null
}

/** Validate one `host:port` pair and turn it into an HTTP proxy URL. */
function proxyAddressToUrl(value: string): string {
  const parsed = splitHostPort(String(value ?? ''), '80')
  if (!parsed) return ''
  const host = parsed.host
  const port = Number(parsed.port)
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return ''
  const family = isIP(host)
  if (family === 0 && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)) return ''
  if (family === 6) return `http://[${host}]:${port}`
  return `http://${host}:${port}`
}

/**
 * Parse the `ProxyServer` value. WinINET stores either one `host:port` or a
 * per-protocol list (`http=host:port;https=host:port`); the HTTPS entry wins
 * because the plugin only talks to GitHub over TLS.
 */
function parseProxyServer(value: string): string {
  const text = String(value ?? '').trim()
  if (!text) return ''
  const entries: Record<string, string> = {}
  for (const part of text.split(';')) {
    const entry = part.trim()
    if (!entry) continue
    const separator = entry.indexOf('=')
    if (separator < 0) continue
    const protocol = entry.slice(0, separator).trim().toLowerCase()
    const address = entry.slice(separator + 1).trim()
    if (protocol && address) entries[protocol] = address
  }
  if (Object.keys(entries).length > 0) return proxyAddressToUrl(entries.https ?? entries.http ?? '')
  return proxyAddressToUrl(text)
}

/**
 * Read the current user's WinINET proxy settings.
 *
 * Read-only by design: `reg query` never writes. Every failure path — a missing
 * `reg`, a non-zero exit code, a non-Windows host, an unparsable value —
 * resolves to `null`; this function never throws.
 */
export async function readSystemProxy(options: SystemProxyOptions = {}): Promise<SystemProxyInfo | null> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return null
  const run = options.execFile ?? defaultRegExec
  try {
    const result = await run('reg', ['query', SYSTEM_PROXY_REG_KEY])
    const enabled = regValue(result.stdout, 'ProxyEnable')
    if (!enabled || Number(enabled) !== 1) return null
    const server = regValue(result.stdout, 'ProxyServer')
    if (!server) return null
    const url = parseProxyServer(server)
    if (!url) return null
    return { url, source: 'system', bypass: regValue(result.stdout, 'ProxyOverride') ?? '' }
  } catch {
    return null
  }
}

/** How long a registry read / local-port probe stays authoritative. */
export const EGRESS_CACHE_TTL_MS = 30000

let systemProxyCache: SystemProxyInfo | null = null
let systemProxyCachedAt = 0
let systemProxyLoaded = false

/**
 * Refresh the cached system-proxy decision. Repeated calls are no-ops inside
 * {@link EGRESS_CACHE_TTL_MS} unless `force` is set; the transport calls this
 * before building its backend chain.
 */
export async function refreshSystemProxy(
  options: SystemProxyOptions & { readonly force?: boolean } = {},
): Promise<SystemProxyInfo | null> {
  if (!options.force && systemProxyLoaded && Date.now() - systemProxyCachedAt < EGRESS_CACHE_TTL_MS) {
    return systemProxyCache
  }
  const info = await readSystemProxy(options)
  systemProxyCache = info
  systemProxyCachedAt = Date.now()
  systemProxyLoaded = true
  return info
}

/** Last value produced by {@link refreshSystemProxy}; `null` before the first read. */
export function cachedSystemProxy(): SystemProxyInfo | null {
  return systemProxyLoaded ? systemProxyCache : null
}

/** True once a registry read settled and has not expired. */
export function systemProxyCacheReady(): boolean {
  return systemProxyLoaded && Date.now() - systemProxyCachedAt < EGRESS_CACHE_TTL_MS
}

/** Local HTTP proxy ports worth probing, in preference order. */
export const LOCAL_PROXY_PORTS: readonly number[] = [7890, 7891, 7897, 7877, 10808, 10809, 1080]
/** Default TCP/CONNECT probe timeout for one local port. */
export const PROXY_PROBE_TIMEOUT_MS = 350

export interface ProxyConnectOptions {
  readonly host: string
  readonly port: number
}

/** Test seam: replace `net.connect`. */
export type ProxyConnect = (options: ProxyConnectOptions) => Socket

export interface ProbeProxyOptions {
  /** Test seam: replace the TCP dial. */
  readonly connect?: ProxyConnect
}

/**
 * Decide whether `host:port` really is a working HTTP proxy: open a TCP
 * connection, send `CONNECT github.com:443`, and accept only a 2xx status line.
 * A timeout, a failed dial or a non-2xx answer resolves to `false`; nothing is
 * thrown, so a SOCKS-only listener can never enter the chain by accident.
 */
export async function probeProxy(
  host: string,
  port: number,
  timeoutMs = PROXY_PROBE_TIMEOUT_MS,
  options: ProbeProxyOptions = {},
): Promise<boolean> {
  const timeout = Number.isFinite(Number(timeoutMs)) ? Math.max(1, Number(timeoutMs)) : PROXY_PROBE_TIMEOUT_MS
  const connect: ProxyConnect = options.connect ?? ((target) => netConnect(target))
  return new Promise<boolean>((resolve) => {
    let settled = false
    let socket: Socket | null = null
    let head = ''
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (socket) {
        try {
          socket.destroy()
        } catch {
          // already closed
        }
      }
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeout)
    try {
      socket = connect({ host, port })
    } catch {
      finish(false)
      return
    }
    socket.once('connect', () => {
      if (!socket) return
      socket.write('CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n')
    })
    socket.on('data', (chunk: Buffer | string) => {
      head += Buffer.from(chunk).toString('latin1')
      const end = head.indexOf('\r\n')
      if (end < 0) return
      const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(head.slice(0, end))
      if (!match) return
      const status = Number(match[1])
      finish(status >= 200 && status < 300)
    })
    socket.once('error', () => finish(false))
    socket.once('close', () => finish(false))
  })
}

export interface LocalProxyDiscoveryOptions {
  /** Test seam: replace the TCP dial used by every probe. */
  readonly connect?: ProxyConnect
  /** Per-port probe timeout; defaults to {@link PROXY_PROBE_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** Ports to probe; defaults to {@link LOCAL_PROXY_PORTS}. */
  readonly ports?: readonly number[]
  /** Ignore a fresh cache and probe again. */
  readonly force?: boolean
}

let localProxyCache: number[] = []
let localProxyCachedAt = 0
let localProxyLoaded = false

/**
 * Probe the fixed local proxy ports and cache the ones that answer CONNECT with
 * a 2xx status. Results are reused for {@link EGRESS_CACHE_TTL_MS}; `force`
 * bypasses the cache.
 */
export async function discoverLocalProxies(options: LocalProxyDiscoveryOptions = {}): Promise<number[]> {
  if (!options.force && localProxyLoaded && Date.now() - localProxyCachedAt < EGRESS_CACHE_TTL_MS) {
    return [...localProxyCache]
  }
  const ports = options.ports ?? LOCAL_PROXY_PORTS
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1, Number(options.timeoutMs))
    : PROXY_PROBE_TIMEOUT_MS
  const results = await Promise.all(
    ports.map(async (port) => {
      const ok = await probeProxy('127.0.0.1', port, timeoutMs, { connect: options.connect })
      return ok ? port : 0
    }),
  )
  localProxyCache = results.filter((port) => port > 0)
  localProxyCachedAt = Date.now()
  localProxyLoaded = true
  return [...localProxyCache]
}

/** Local proxy ports from the last discovery; empty before the first run. */
export function cachedLocalProxyPorts(): number[] {
  return localProxyLoaded ? [...localProxyCache] : []
}

/** True once local proxy discovery settled and has not expired. */
export function localProxyCacheReady(): boolean {
  return localProxyLoaded && Date.now() - localProxyCachedAt < EGRESS_CACHE_TTL_MS
}

/** Drop cached system-proxy / local-port discovery results (tests, diagnostics). */
export function resetEgressCache(): void {
  systemProxyCache = null
  systemProxyCachedAt = 0
  systemProxyLoaded = false
  localProxyCache = []
  localProxyCachedAt = 0
  localProxyLoaded = false
}

/** Result of `chooseProxy`. `mode: 'proxy'` means the proxy backend is used. */
export interface ProxyDecision {
  readonly mode: 'direct' | 'proxy'
  readonly proxy: string | null
  /** Why this decision was made: off / manual / no-proxy / env / config / none. */
  readonly source: string
  readonly reason: string
}

/**
 * Decide whether `url` goes direct or through a proxy.
 *
 * - `auto`   : `NO_PROXY` wins; otherwise config proxy, then the system proxy
 *              read from the registry, then `HTTPS_PROXY` / `HTTP_PROXY`
 *              (upper- or lower-case).
 * - `manual` : config `proxyUrl` only; empty means direct.
 * - `off`    : always direct, proxies are ignored.
 */
export function chooseProxy(
  url: string,
  env: Record<string, string | undefined> = process.env,
  config: NetworkConfig = {},
): ProxyDecision {
  const mode = normalizeMode(config.networkMode)
  if (mode === 'off') {
    return { mode: 'direct', proxy: null, source: 'off', reason: 'networkMode=off, direct only' }
  }

  let host = ''
  let port = ''
  try {
    const target = new URL(String(url))
    host = target.hostname
    port = target.port || (target.protocol === 'https:' ? '443' : '80')
  } catch {
    return { mode: 'direct', proxy: null, source: 'invalid-url', reason: 'url could not be parsed' }
  }

  const configured = String(config.proxyUrl ?? '').trim()

  if (mode === 'manual') {
    if (configured) {
      return { mode: 'proxy', proxy: configured, source: 'manual', reason: 'networkMode=manual, proxyUrl configured' }
    }
    return { mode: 'direct', proxy: null, source: 'manual-empty', reason: 'networkMode=manual without proxyUrl' }
  }

  const noProxy = readEnv(env, 'NO_PROXY', 'no_proxy')
  if (noProxy && noProxyMatches(host, port, noProxy)) {
    return { mode: 'direct', proxy: null, source: 'no-proxy', reason: `NO_PROXY matched ${host}:${port}` }
  }
  if (configured) {
    return { mode: 'proxy', proxy: configured, source: 'config', reason: 'networkMode=auto, proxyUrl configured' }
  }
  const system = cachedSystemProxy()
  if (system) {
    if (!system.bypass || !noProxyMatches(host, port, system.bypass)) {
      return { mode: 'proxy', proxy: system.url, source: 'system', reason: 'networkMode=auto, system proxy enabled' }
    }
  }
  const fromEnv =
    readEnv(env, 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy') || ''
  if (fromEnv) {
    return { mode: 'proxy', proxy: fromEnv, source: 'env', reason: 'networkMode=auto, proxy from environment' }
  }
  return { mode: 'direct', proxy: null, source: 'none', reason: 'networkMode=auto, no proxy configured' }
}

/** Build the actual DoH query URL for one endpoint and host. */
export function dohEndpointUrl(endpoint: string, host: string): string {
  const template = String(endpoint ?? '').trim()
  if (!template) return ''
  if (template.includes('{host}')) return template.replaceAll('{host}', encodeURIComponent(host))
  try {
    const url = new URL(template)
    if (!url.searchParams.has('name')) url.searchParams.set('name', host)
    if (!url.searchParams.has('type')) url.searchParams.set('type', 'A')
    return url.toString()
  } catch {
    return template
  }
}

/**
 * Extract IPv4 A records from a DNS-over-HTTPS JSON answer.
 *
 * Cloudflare (`1.1.1.1/dns-query`) and AliDNS (`dns.alidns.com/resolve`)
 * disagree on the query transport but both answer with the DNS-JSON shape
 * `{ Status: 0, Answer: [{ name, type: 1, data }] }`. Entries with
 * `type === 1` (or `"A"`) are kept; other record types are skipped.
 */
function pushAnswers(payload: unknown, host: string, out: string[]): void {
  const answer = (payload as { Answer?: unknown } | null)?.Answer
  if (!Array.isArray(answer)) return
  const wanted = host.toLowerCase().replace(/\.$/, '')
  const record = (value: unknown): void => {
    const data = String(value ?? '').trim()
    if (isIP(data) !== 4 || out.includes(data)) return
    out.push(data)
  }
  for (const raw of answer) {
    const entry = (raw ?? {}) as { name?: unknown; type?: unknown; data?: unknown }
    const type = entry.type
    if (Number(type) !== 1 && String(type ?? '').toUpperCase() !== 'A') continue
    const name = String(entry.name ?? '').toLowerCase().replace(/\.$/, '')
    if (name && name !== wanted && !name.endsWith(`.${wanted}`)) continue
    if (Array.isArray(entry.data)) {
      for (const value of entry.data) record(value)
    } else {
      record(entry.data)
    }
  }
}

export interface DohOptions {
  readonly endpoints?: string[]
  /** Per-endpoint timeout; defaults to {@link DOH_ENDPOINT_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** Whole-round budget; defaults to {@link DOH_TOTAL_BUDGET_MS}. */
  readonly totalBudgetMs?: number
  readonly signal?: AbortSignal
  /** Test seam: wall clock used for budget accounting. */
  readonly now?: () => number
  readonly fetchImpl?: typeof fetch
}

/**
 * Resolve the IPv4 A records of `host` through the configured DoH endpoints,
 * trying them in order and returning the first non-empty answer set.
 *
 * Budget accounting is wall-clock based (`Date.now()`), not per-socket: each
 * endpoint may use at most `timeoutMs` (2.5s) and the whole round may use at
 * most `totalBudgetMs` (5s). When the round budget runs out the remaining
 * endpoints are skipped instead of adding another socket timeout each.
 */
export async function resolveDoh(host: string, options: DohOptions = {}): Promise<string[]> {
  const endpoints = (options.endpoints && options.endpoints.length ? options.endpoints : DEFAULT_DOH_ENDPOINTS).filter(
    (endpoint) => String(endpoint ?? '').trim(),
  )
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(50, Number(options.timeoutMs))
    : DOH_ENDPOINT_TIMEOUT_MS
  const totalBudgetMs = Number.isFinite(Number(options.totalBudgetMs))
    ? Math.max(100, Number(options.totalBudgetMs))
    : DOH_TOTAL_BUDGET_MS
  const now = typeof options.now === 'function' ? options.now : Date.now
  const outerSignal = options.signal
  const doFetch = options.fetchImpl ?? fetch
  const failures: string[] = []
  const startedAt = now()
  let answered = false
  let attempted = 0
  for (const endpoint of endpoints) {
    const remaining = totalBudgetMs - (now() - startedAt)
    if (remaining <= 0) break
    attempted += 1
    const budgetedTimeout = Math.max(1, Math.min(timeoutMs, remaining))
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    if (outerSignal) {
      if (outerSignal.aborted) controller.abort()
      else outerSignal.addEventListener('abort', onAbort, { once: true })
    }
    const timer = setTimeout(() => controller.abort(), budgetedTimeout)
    try {
      const queryUrl = dohEndpointUrl(endpoint, host)
      if (!queryUrl) throw new Error('empty endpoint')
      const payload = await withDeadline(
        (async () => {
          const response = await doFetch(queryUrl, {
            signal: controller.signal,
            headers: { accept: 'application/dns-json', 'user-agent': 'dsh-github-trending/1.0' },
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return response.json()
        })(),
        budgetedTimeout,
        () => controller.abort(),
      )
      answered = true
      const records: string[] = []
      pushAnswers(payload, host, records)
      if (records.length > 0) return records
    } catch (error) {
      failures.push(`${endpoint}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timer)
      if (outerSignal) outerSignal.removeEventListener('abort', onAbort)
    }
  }
  if (!answered && failures.length > 0) {
    const elapsed = Math.max(0, now() - startedAt)
    throw new Error(
      `DoH resolution failed for ${host} (tried ${attempted}/${endpoints.length} endpoints in ${elapsed}ms; ${failures.join('; ')})`,
    )
  }
  return []
}

function requestOptionsFor(
  target: URL,
  init: NetRequestInit,
): { protocol: string; hostname: string; port: string; path: string; method: string; headers: Record<string, string> } {
  const secure = target.protocol === 'https:'
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(init.headers ?? {})) headers[key] = String(value)
  if (!Object.keys(headers).some((key) => key.toLowerCase() === 'host')) headers.host = target.host
  return {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (secure ? '443' : '80'),
    path: `${target.pathname}${target.search}`,
    method: (init.method ?? 'GET').toUpperCase(),
    headers,
  }
}

function readBody(init: NetRequestInit): string | Uint8Array | undefined {
  return init.body
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, onAbort: () => void): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    onAbort()
    return Promise.reject(new Error('request aborted'))
  }
  return new Promise<T>((resolve, reject) => {
    const relay = (): void => {
      onAbort()
      reject(new Error('request aborted'))
    }
    signal.addEventListener('abort', relay, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', relay)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', relay)
        reject(error)
      },
    )
  })
}

function requestOverSocket(
  target: URL,
  socket: Socket | TLSSocket,
  init: NetRequestInit,
  via: string,
): Promise<NetResponse> {
  const options = requestOptionsFor(target, init)
  const body = readBody(init)
  const timeoutMs = init.timeoutMs ?? 20000
  return new Promise<NetResponse>((resolve, reject) => {
    let settled = false
    const finish = (error: Error | null, value?: NetResponse): void => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else if (value) resolve(value)
    }
    const req = httpRequest(
      {
        host: options.hostname,
        port: options.port,
        path: options.path,
        method: options.method,
        headers: options.headers,
        // No `agent` here: with `agent: false` Node ignores `createConnection`
        // and dials the target host itself, which would bypass the CONNECT
        // tunnel entirely.
        createConnection: () => socket,
      },
      (res: any) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          finish(null, {
            status: Number(res.statusCode ?? 0),
            text: Buffer.concat(chunks).toString('utf8'),
            url: target.toString(),
            via,
          }),
        )
        res.on('error', (error: Error) => finish(error))
      },
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timeout after ${timeoutMs}ms`)))
    req.on('error', (error: Error) => finish(error))
    if (body !== undefined) req.write(body)
    req.end()
    abortable(
      new Promise<void>((done) => {
        req.on('close', () => done())
      }),
      init.signal,
      () => finish(new Error('request aborted')),
    ).catch(() => {
      /* abort already routed through finish above */
    })
  })
}

/**
 * Build the `lookup` hook that pins a request to one address.
 *
 * Node calls a `lookup` option in two forms: `lookup(host, options, callback)`
 * and the legacy `lookup(host, callback)`. When `autoSelectFamily` is active
 * (the default for `net.connect` on modern Node) Node passes `{ all: true }`
 * and the callback must receive an **array** of `{ address, family }`; the
 * three-argument `(error, address, family)` form is rejected by Node with
 * `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined`.
 */
export function createAddressLookup(ip: string): (
  hostname: string,
  options: { all?: boolean } | ((...args: any[]) => void),
  callback?: (...args: any[]) => void,
) => void {
  const family = isIP(ip)
  if (family === 0) throw new Error(`not a valid IP address: ${ip}`)
  return (_hostname, options, callback) => {
    let resolvedOptions: { all?: boolean } = {}
    let done = callback
    if (typeof options === 'function') {
      done = options
    } else if (options && typeof options === 'object') {
      resolvedOptions = options
    }
    if (typeof done !== 'function') return
    if (resolvedOptions.all) {
      done(null, [{ address: ip, family }])
      return
    }
    done(null, ip, family)
  }
}

/** Fetch one HTTP(S) URL while resolving `hostname` to the supplied IP. */
export async function fetchViaAddress(url: string, ip: string, init: NetRequestInit = {}): Promise<NetResponse> {
  const target = new URL(url)
  const family = isIP(ip)
  if (family === 0) throw new Error(`not a valid IP address: ${ip}`)
  const secure = target.protocol === 'https:'
  const lib = secure ? httpsRequest : httpRequest
  const options = requestOptionsFor(target, init)
  const body = readBody(init)
  const timeoutMs = init.timeoutMs ?? 20000
  const response = await new Promise<NetResponse>((resolve, reject) => {
    let settled = false
    const finish = (error: Error | null, value?: NetResponse): void => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else if (value) resolve(value)
    }
    const req = lib(
      {
        protocol: options.protocol,
        hostname: options.hostname,
        port: options.port,
        path: options.path,
        method: options.method,
        headers: options.headers,
        agent: false,
        ...(secure
          ? {
              servername: target.hostname,
              rejectUnauthorized: init.rejectUnauthorized !== false,
              ...(init.ca && (Array.isArray(init.ca) ? init.ca.length > 0 : String(init.ca).trim())
                ? { ca: init.ca }
                : {}),
            }
          : {}),
        lookup: createAddressLookup(ip),
      } as any,
      (res: any) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          finish(null, {
            status: Number(res.statusCode ?? 0),
            text: Buffer.concat(chunks).toString('utf8'),
            url: target.toString(),
            via: 'doh-ip',
          }),
        )
        res.on('error', (error: Error) => finish(error))
      },
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timeout after ${timeoutMs}ms`)))
    req.on('error', (error: Error) => finish(error))
    if (body !== undefined) req.write(body)
    req.end()
    const onAbort = (): void => req.destroy(new Error('request aborted'))
    if (init.signal) {
      if (init.signal.aborted) onAbort()
      else init.signal.addEventListener('abort', onAbort, { once: true })
    }
  })
  return response
}

/**
 * Request one https URL through a TLS-intercepting local accelerator.
 *
 * The TCP connection goes to `127.0.0.1:<port>`, while `servername` (SNI) and
 * the `Host` header stay the real host name and certificate verification is
 * **on**. The PEM in `ca` is the only extra trust anchor; an empty `ca` keeps
 * the default public trust store, so a self-signed local listener fails the
 * handshake instead of being silently accepted.
 *
 * `init` is handled exactly like {@link fetchViaAddress}: method, headers and
 * body reach the listener, and `timeoutMs` / `signal` bound the dial. Without
 * this the intercepted request silently fell back to a bare GET, which GitHub
 * answers with 403 because it never sees a `user-agent` or `authorization`.
 */
export async function fetchLocalMitm(
  url: string,
  ca: string | string[],
  port = 443,
  init: NetRequestInit = {},
): Promise<NetResponse> {
  const target = new URL(url)
  if (target.protocol !== 'https:') throw new Error(`local-mitm needs an https url: ${url}`)
  const options = requestOptionsFor(target, init)
  const timeoutMs = init.timeoutMs ?? 20000
  const body = readBody(init)
  const caValue = Array.isArray(ca)
    ? ca.map((value) => String(value ?? '')).filter((value) => value.trim())
    : String(ca ?? '').trim()
  const hasCa = Array.isArray(caValue) ? caValue.length > 0 : caValue.length > 0
  return new Promise<NetResponse>((resolve, reject) => {
    let settled = false
    const finish = (error: Error | null, value?: NetResponse): void => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else if (value) resolve(value)
    }
    const req = httpsRequest(
      {
        protocol: 'https:',
        hostname: '127.0.0.1',
        port: String(port),
        path: options.path,
        method: options.method,
        headers: options.headers,
        servername: target.hostname,
        rejectUnauthorized: true,
        ...(hasCa ? { ca: caValue } : {}),
        agent: false,
      } as any,
      (res: any) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          finish(null, {
            status: Number(res.statusCode ?? 0),
            text: Buffer.concat(chunks).toString('utf8'),
            url: target.toString(),
            via: 'local-mitm',
          }),
        )
        res.on('error', (error: Error) => finish(error))
      },
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timeout after ${timeoutMs}ms`)))
    req.on('error', (error: Error) => finish(error))
    if (body !== undefined) req.write(body)
    req.end()
    const onAbort = (): void => req.destroy(new Error('request aborted'))
    if (init.signal) {
      if (init.signal.aborted) onAbort()
      else init.signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

export interface AddressRoundOptions {
  /** Per-address timeout; defaults to {@link ADDRESS_ATTEMPT_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** Whole-round budget; defaults to {@link ADDRESS_TOTAL_BUDGET_MS}. */
  readonly totalBudgetMs?: number
  /** Test seam: wall clock used for budget accounting. */
  readonly now?: () => number
  /** Test seam: replace the per-address dial (defaults to `fetchViaAddress`). */
  readonly attempt?: (url: string, ip: string, init: NetRequestInit) => Promise<NetResponse>
}

/**
 * Try candidate addresses in order under one wall-clock budget.
 *
 * Each address gets at most `timeoutMs` (4s) and the whole round gets at most
 * `totalBudgetMs` (12s); once the round budget is spent no further address is
 * dialled. A failed round names how many addresses were tried and the elapsed
 * time, so the panel error can say "已尝试 N 个地址、总耗时 X ms" instead of
 * showing a bare timeout.
 */
export async function fetchViaAddresses(
  url: string,
  addresses: readonly string[],
  init: NetRequestInit = {},
  options: AddressRoundOptions = {},
): Promise<NetResponse> {
  const now = typeof options.now === 'function' ? options.now : Date.now
  const perAddress = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(50, Number(options.timeoutMs))
    : ADDRESS_ATTEMPT_TIMEOUT_MS
  const totalBudgetMs = Number.isFinite(Number(options.totalBudgetMs))
    ? Math.max(100, Number(options.totalBudgetMs))
    : ADDRESS_TOTAL_BUDGET_MS
  const attempt = options.attempt ?? fetchViaAddress
  const startedAt = now()
  const failures: string[] = []
  let attempted = 0
  for (const ip of addresses) {
    const remaining = totalBudgetMs - (now() - startedAt)
    if (remaining <= 0) break
    attempted += 1
    const budgetedTimeout = Math.max(1, Math.min(perAddress, remaining))
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    if (init.signal) {
      if (init.signal.aborted) controller.abort()
      else init.signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      return await withDeadline(
        attempt(url, ip, { ...init, timeoutMs: budgetedTimeout, signal: controller.signal }),
        budgetedTimeout,
        () => controller.abort(),
      )
    } catch (error) {
      failures.push(`${ip}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (init.signal) init.signal.removeEventListener('abort', onAbort)
    }
  }
  const elapsed = Math.max(0, now() - startedAt)
  const detail = failures.length > 0 ? `; ${failures.join('; ')}` : ''
  throw new Error(
    `no candidate address answered for ${url}（已尝试 ${attempted} 个地址、总耗时 ${elapsed} ms${detail}）`,
  )
}

function parseProxyUrl(proxyUrl: string): URL {
  const raw = String(proxyUrl ?? '').trim()
  if (!raw) throw new Error('empty proxy url')
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
  const url = new URL(withScheme)
  if (!url.hostname) throw new Error(`invalid proxy url: ${proxyUrl}`)
  return url
}

function openTunnel(
  proxy: URL,
  authority: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    let settled = false
    let secureSocket: Socket | TLSSocket = netConnect({
      host: proxy.hostname,
      port: Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80)),
    })
    let buffer = Buffer.alloc(0)
    const timer = setTimeout(() => {
      settle(new Error(`CONNECT timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    function settle(error: Error | null, value?: Socket | TLSSocket): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      if (error) {
        secureSocket.destroy()
        reject(error)
      } else if (value) {
        resolve(value)
      }
    }
    function onAbort(): void {
      settle(new Error('request aborted'))
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      const marker = buffer.indexOf('\r\n\r\n')
      if (marker < 0) return
      const head = buffer.subarray(0, marker).toString('latin1')
      const rest = buffer.subarray(marker + 4)
      const statusLine = head.split(/\r?\n/)[0] ?? ''
      const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine)
      const status = match ? Number(match[1]) : 0
      if (status !== 200) {
        settle(new Error(`proxy CONNECT failed: ${statusLine || 'empty response'}`))
        return
      }
      secureSocket.removeListener('data', onData)
      secureSocket.removeListener('error', onError)
      if (rest.length > 0) secureSocket.unshift(rest)
      secureSocket.on('error', () => {
        /* errors are surfaced through the request socket */
      })
      settle(null, secureSocket)
    }
    const onError = (error: Error): void => settle(error)

    const sendConnect = (): void => {
      secureSocket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Connection: Keep-Alive\r\n\r\n`,
      )
    }

    if (proxy.protocol === 'https:') {
      const tlsSocket = tlsConnect({
        socket: secureSocket,
        servername: proxy.hostname,
        rejectUnauthorized: true,
      })
      secureSocket = tlsSocket
      tlsSocket.once('error', onError)
      tlsSocket.on('data', onData)
      tlsSocket.once('secureConnect', sendConnect)
    } else {
      secureSocket.on('data', onData)
      secureSocket.once('error', onError)
      secureSocket.once('connect', sendConnect)
    }
  })
}

function secureTunnel(
  socket: Socket | TLSSocket,
  hostname: string,
  init: NetRequestInit,
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tlsConnect({
      socket,
      servername: hostname,
      rejectUnauthorized: init.rejectUnauthorized !== false,
    })
    tlsSocket.once('secureConnect', () => resolve(tlsSocket))
    tlsSocket.once('error', reject)
  })
}

/**
 * Minimal HTTP CONNECT tunnel. The proxy is dialled over plain TCP (or TLS for
 * `https://` proxy URLs), a CONNECT request is issued, and the HTTP request is
 * then written over the tunnelled socket.
 */
export async function requestViaProxy(
  url: string,
  proxyUrl: string,
  init: NetRequestInit = {},
): Promise<NetResponse> {
  const target = new URL(url)
  const proxy = parseProxyUrl(proxyUrl)
  const secure = target.protocol === 'https:'
  const targetPort = target.port || (secure ? '443' : '80')
  const authority = `${target.hostname}:${targetPort}`
  const timeoutMs = init.timeoutMs ?? 20000
  const rawSocket = await openTunnel(proxy, authority, timeoutMs, init.signal)
  let connection: Socket | TLSSocket = rawSocket
  if (secure) connection = await secureTunnel(rawSocket, target.hostname, init)
  return requestOverSocket(target, connection, init, 'proxy')
}
