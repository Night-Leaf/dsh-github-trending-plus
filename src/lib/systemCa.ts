/**
 * Trust anchor discovery for a local TLS-intercepting accelerator.
 *
 * Some Windows accelerators (Steam++ / Watt Toolkit and friends) take over the
 * GitHub host names in the hosts file, listen on `127.0.0.1:443` and present a
 * leaf certificate signed by a private root they installed into the Windows
 * root store. Node does not read the Windows store for its own CA bundle, so a
 * plain HTTPS request to the intercepted host fails with
 * `UNABLE_TO_VERIFY_LEAF_SIGNATURE` while the browser works fine.
 *
 * `ensureCaPem()` re-exports **only** the root that actually signed the leaf
 * the local listener presented:
 *
 *   1. TLS-probe `127.0.0.1:<port>` with `servername` set to the real host,
 *      `rejectUnauthorized: false` (this probe only learns who signed the
 *      leaf; it does not trust anything).
 *   2. Read the leaf's issuer certificate if the listener includes it in the
 *      chain; otherwise keep the leaf PEM + issuer subject so a candidate root
 *      can be verified cryptographically (`checkIssued` + signature).
 *   3. List the Windows `CurrentUser\Root` / `LocalMachine\Root` candidates
 *      (filtered by the issuer subject) and keep the one whose SHA-256
 *      fingerprint equals the issuer's — or, when the issuer certificate was
 *      not sent, the one that provably signed the leaf.
 *   4. Export that single certificate as PEM to
 *      `%USERPROFILE%\.dsh\github-trending-ca.pem` (atomic write), reusing a
 *      cache younger than seven days.
 *
 * A missing match or a fingerprint mismatch yields `null`: nothing is cached
 * and the accelerator's certificate is not trusted.
 *
 * Only Node built-ins are used; no third-party dependency is added.
 *
 * @module @royalsan/dsh-github-trending/systemCa
 */

import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { X509Certificate } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { connect as tlsConnect } from 'node:tls'

/** What the local listener's certificate chain says about its issuer. */
export interface LeafIssuer {
  /**
   * SHA-256 fingerprint of the issuing certificate, colon-separated hex. Only
   * available when the listener includes its root in the TLS chain; most
   * interceptors do not, which is why `subject` / `leafPem` exist.
   */
  readonly fingerprint256?: string
  /** Issuer subject (usually `CN=…`), used only to narrow the root listing. */
  readonly subject?: string
  /** Leaf certificate in PEM; lets a candidate root be verified offline. */
  readonly leafPem?: string
}

/** One candidate from the Windows root store. */
export interface RootCandidate {
  readonly subject: string
  readonly fingerprint256: string
  readonly pem: string
}

/** Injection points; production code uses the defaults. */
export interface SystemCaOptions {
  /** PEM cache path; defaults to `%USERPROFILE%\.dsh\github-trending-ca.pem`. */
  readonly cachePath?: string
  /** Local listener port; defaults to 443. */
  readonly port?: number
  /** Probe the local listener; defaults to a real TLS handshake. */
  readonly probe?: (host: string) => Promise<LeafIssuer | null>
  /** Read the root store; defaults to PowerShell over both Root stores. */
  readonly listRoots?: (issuer: LeafIssuer) => Promise<readonly RootCandidate[]>
  /** Ignore the cache and export again (used once after a TLS verify failure). */
  readonly force?: boolean
  /** Wall clock, injectable for tests. */
  readonly now?: () => number
  /** Cache lifetime; defaults to seven days. */
  readonly maxAgeMs?: number
}

/** A cached PEM is reused while it is younger than this. */
export const CA_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

const PROBE_TIMEOUT_MS = 5000
const POWERSHELL_TIMEOUT_MS = 20000

/** `%USERPROFILE%\.dsh\github-trending-ca.pem`, the shared default path. */
export function defaultCaCachePath(): string {
  const home = String(process.env.USERPROFILE ?? '').trim() || homedir()
  return path.join(home, '.dsh', 'github-trending-ca.pem')
}

/** Normalise `AA:BB:…` / `aabb…` to one comparable form. */
function normalizeFingerprint(value: unknown): string {
  return String(value ?? '')
    .replace(/[^0-9a-f]/gi, '')
    .toUpperCase()
}

function pemFromRaw(raw: unknown): string {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer)
  const body = bytes.toString('base64').replace(/(.{64})/g, '$1\n').trim()
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`
}

/** `CN=…` for the issuer of `cert`; empty when the CN is absent. */
function issuerLabel(cert: any): string {
  const issuer = cert && cert.issuer && typeof cert.issuer === 'object' ? cert.issuer : {}
  const cn = String(issuer.CN ?? '').trim()
  return cn ? `CN=${cn}` : ''
}

/** Real TLS probe: `127.0.0.1:<port>`, SNI = the intercepted host. */
function probeLocalCertificate(host: string, port: number): Promise<LeafIssuer> {
  return new Promise<LeafIssuer>((resolve, reject) => {
    let settled = false
    const socket = tlsConnect({
      host: '127.0.0.1',
      port,
      servername: host,
      rejectUnauthorized: false,
      timeout: PROBE_TIMEOUT_MS,
    })
    const finish = (error: Error | null, value?: LeafIssuer): void => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      if (error) reject(error)
      else if (value) resolve(value)
    }
    socket.once('secureConnect', () => {
      try {
        const cert: any = socket.getPeerCertificate(true)
        if (!cert || !cert.raw) {
          finish(new Error('local listener did not present a certificate'))
          return
        }
        const issuer = cert.issuerCertificate
        finish(null, {
          ...(issuer && issuer.fingerprint256 ? { fingerprint256: String(issuer.fingerprint256) } : {}),
          subject: issuerLabel(cert),
          leafPem: pemFromRaw(cert.raw),
        })
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.once('error', (error: Error) => finish(error))
    socket.once('timeout', () => finish(new Error(`TLS probe to 127.0.0.1:${port} timed out`)))
  })
}

/**
 * PowerShell 5.1 script: one compact JSON object per root certificate. The
 * subject filter is passed through the environment so no string has to be
 * spliced into the command line; an empty filter lists both stores.
 */
const PS_LIST_ROOTS = [
  '$ErrorActionPreference = "SilentlyContinue"',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$needle = $env:DSH_MITM_ISSUER_SUBJECT',
  '$sha = [System.Security.Cryptography.SHA256]::Create()',
  'foreach ($store in @("Cert:\\CurrentUser\\Root", "Cert:\\LocalMachine\\Root")) {',
  '  Get-ChildItem -Path $store | ForEach-Object {',
  '    if ($needle -and -not $_.Subject.Contains($needle)) { return }',
  '    $raw = $_.RawData',
  '    $fp = (($sha.ComputeHash($raw) | ForEach-Object { $_.ToString("X2") }) -join ":")',
  '    $pem = "-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($raw, "InsertLineBreaks") + "`n-----END CERTIFICATE-----"',
  '    [pscustomobject]@{ subject = $_.Subject; fingerprint256 = $fp; pem = $pem } | ConvertTo-Json -Compress',
  '  }',
  '}',
].join('\n')

function runPowerShell(script: string, filter: string): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (filter) env.DSH_MITM_ISSUER_SUBJECT = filter
  else delete env.DSH_MITM_ISSUER_SUBJECT
  return new Promise<string>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: POWERSHELL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(String(stdout ?? ''))
      },
    )
  })
}

function parseRootLines(stdout: string): RootCandidate[] {
  const roots: RootCandidate[] = []
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const text = line.replace(/^\uFEFF/, '').trim()
    if (!text.startsWith('{')) continue
    try {
      const value = JSON.parse(text)
      const fingerprint256 = String(value?.fingerprint256 ?? '').trim()
      const pem = String(value?.pem ?? '').trim()
      if (!fingerprint256 || !pem.includes('-----BEGIN CERTIFICATE-----')) continue
      roots.push({ subject: String(value?.subject ?? ''), fingerprint256, pem })
    } catch {
      // A malformed line is not a candidate; fall through to the next one.
    }
  }
  return roots
}

/**
 * Default root-store reader. The issuer subject narrows the PowerShell output;
 * when that filter finds nothing the unfiltered listing is tried once, so a
 * subject-format mismatch can never hide a matching fingerprint. Non-Windows
 * hosts have no Windows store and return no candidates.
 */
async function listRootsViaPowerShell(issuer: LeafIssuer): Promise<RootCandidate[]> {
  if (process.platform !== 'win32') return []
  const filter = String(issuer.subject ?? '').trim()
  const filtered = parseRootLines(await runPowerShell(PS_LIST_ROOTS, filter))
  if (filtered.length > 0 || !filter) return filtered
  return parseRootLines(await runPowerShell(PS_LIST_ROOTS, ''))
}

function readCachedPem(cachePath: string, now: number, maxAgeMs: number): string | null {
  try {
    const stat = statSync(cachePath)
    if (now - stat.mtimeMs > maxAgeMs) return null
    const text = readFileSync(cachePath, 'utf8').trim()
    return text.includes('-----BEGIN CERTIFICATE-----') ? text : null
  } catch {
    return null
  }
}

function removeQuietly(file: string): void {
  try {
    unlinkSync(file)
  } catch {
    // Missing file is the normal case.
  }
}

/** Temporary file + rename, so a reader never sees a half-written PEM. */
function writeCacheFile(cachePath: string, pem: string): void {
  mkdirSync(path.dirname(cachePath), { recursive: true })
  const temp = `${cachePath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, pem, 'utf8')
  renameSync(temp, cachePath)
}

/**
 * True when `rootPem` provably issued `leafPem`: the root's public key
 * verifies the leaf's signature, and either the leaf names it as issuer
 * (`checkIssued`, honouring the authority key identifier) or the two are the
 * same self-signed certificate (equal SHA-256 fingerprints). Used only when
 * the local listener did not include its issuer certificate in the chain.
 */
function candidateIssuedLeaf(rootPem: string, leafPem: string): boolean {
  try {
    const leaf = new X509Certificate(leafPem)
    const root = new X509Certificate(rootPem)
    if (!leaf.verify(root.publicKey)) return false
    return leaf.checkIssued(root) || leaf.fingerprint256 === root.fingerprint256
  } catch {
    return false
  }
}

/**
 * Return the PEM of the root that signed the certificate presented on
 * `127.0.0.1:<port>` for `host`, or `null` when it cannot be proven.
 *
 * A fingerprint from the presented chain is authoritative: only an exact match
 * is exported. When the listener sent no issuer certificate, only a candidate
 * root that provably signed the leaf is exported. A mismatch or an unreachable
 * probe never writes the cache.
 */
export async function ensureCaPem(host: string, options: SystemCaOptions = {}): Promise<string | null> {
  const target = String(host ?? '').trim().toLowerCase().replace(/\.$/, '')
  if (!target) return null
  const cachePath = String(options.cachePath ?? '').trim() || defaultCaCachePath()
  const now = typeof options.now === 'function' ? options.now : Date.now
  const maxAgeMs = Number.isFinite(Number(options.maxAgeMs))
    ? Math.max(0, Number(options.maxAgeMs))
    : CA_CACHE_MAX_AGE_MS

  if (options.force) removeQuietly(cachePath)
  else {
    const cached = readCachedPem(cachePath, now(), maxAgeMs)
    if (cached) return cached
  }

  try {
    const probe = options.probe ?? ((value: string) => probeLocalCertificate(value, options.port ?? 443))
    const leaf = await probe(target)
    if (!leaf) return null
    const wanted = normalizeFingerprint(leaf.fingerprint256)
    const listRoots = options.listRoots ?? listRootsViaPowerShell
    const roots = (await listRoots(leaf)) ?? []
    const match = wanted
      ? roots.find((root) => normalizeFingerprint(root.fingerprint256) === wanted)
      : leaf.leafPem
        ? roots.find((root) => candidateIssuedLeaf(root.pem, leaf.leafPem as string))
        : undefined
    const pem = String(match?.pem ?? '').trim()
    if (!pem.includes('-----BEGIN CERTIFICATE-----')) return null
    try {
      writeCacheFile(cachePath, pem.endsWith('\n') ? pem : `${pem}\n`)
    } catch {
      // A read-only home directory must not block this request: the PEM is
      // still correct, it just cannot be cached for the next call.
    }
    return pem
  } catch {
    return null
  }
}
