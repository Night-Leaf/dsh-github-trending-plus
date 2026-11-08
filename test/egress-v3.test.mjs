#!/usr/bin/env node
/**
 * Offline tests for Task-1 / Task-2 (egress v3): system-proxy parsing, local
 * port probing, fallback-chain order, and the local TLS-interception backend
 * with its single-root CA export.
 *
 * No request leaves this machine and the real registry / certificate store is
 * never read: every `reg` invocation and every TCP probe is injected, every
 * proxy is a loopback server built in this file, and the `direct` backend is
 * replaced by a stub. The TLS fixtures under `test/fixtures/egress/` are
 * committed files, so no PowerShell runs during a test run either.
 *
 * Run with: node build.mjs && node --test test/egress-v3.test.mjs
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  LOCAL_PROXY_PORTS,
  cachedLocalProxyPorts,
  chooseProxy,
  discoverLocalProxies,
  fetchLocalMitm,
  probeProxy,
  readSystemProxy,
  refreshSystemProxy,
  resetEgressCache,
} from '../lib/net.js'
import { configureNetwork, currentCaPath, currentTotalBudgetMs, fetchText, textBackendIds } from '../lib/http.js'
import { reportFetchWindowMs } from '../lib/report.js'
import { ensureCaPem } from '../lib/systemCa.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.join(here, 'fixtures', 'egress')
const FIXTURE_PFX = readFileSync(path.join(FIXTURE_DIR, 'localhost.pfx'))
const FIXTURE_PEM = readFileSync(path.join(FIXTURE_DIR, 'localhost.pem'), 'utf8').trim()

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function close(server) {
  return new Promise((resolve) => server.close(resolve))
}

/** Reproduce the `reg query <key>` output shape the real parser sees. */
function regOutput(values) {
  const lines = ['', REG_KEY]
  for (const [name, value] of Object.entries(values)) {
    const type = name === 'ProxyEnable' ? 'REG_DWORD' : 'REG_SZ'
    lines.push(`    ${name}    ${type}    ${value}`)
  }
  return `${lines.join('\r\n')}\r\n`
}

/** Injected replacement for `reg.exe`; records every call for assertions. */
function fakeReg(values, error) {
  const calls = []
  const exec = (file, args) => {
    calls.push({ file, args })
    if (error) return Promise.reject(error)
    return Promise.resolve({ stdout: regOutput(values) })
  }
  exec.calls = calls
  return exec
}

/** Minimal TCP socket double: emits connect, replays one HTTP reply on write. */
function fakeSocket(response) {
  const socket = new EventEmitter()
  socket.written = ''
  socket.destroy = () => {
    socket.destroyed = true
  }
  socket.write = (chunk) => {
    socket.written += String(chunk)
    if (response) {
      setTimeout(() => socket.emit('data', Buffer.from(response)), 0)
    }
  }
  setTimeout(() => socket.emit('connect'), 0)
  return socket
}

/** Injected net.connect: ports map to replies or are refused. */
function fakeConnect(replies) {
  return ({ port }) => {
    const reply = replies[port]
    if (!reply) throw Object.assign(new Error(`ECONNREFUSED 127.0.0.1:${port}`), { code: 'ECONNREFUSED' })
    return fakeSocket(reply)
  }
}

const CONNECT_OK = 'HTTP/1.1 200 Connection Established\r\n\r\n'

/** A loopback HTTP proxy that really tunnels CONNECT to `originPort`. */
async function startConnectProxy(originPort, body) {
  const state = { connects: 0, authorities: [] }
  const proxy = http.createServer((req, res) => {
    res.statusCode = 405
    res.end('CONNECT only')
  })
  proxy.on('connect', (req, clientSocket, head) => {
    state.connects += 1
    state.authorities.push(String(req.url || ''))
    if (originPort === 0) {
      clientSocket.write(CONNECT_OK)
      clientSocket.end(`HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
      return
    }
    const upstream = net.connect(originPort, '127.0.0.1', () => {
      clientSocket.write(CONNECT_OK)
      if (head && head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
  const port = await listen(proxy)
  return { proxy, port, state }
}

/** Loopback origin that answers every request with one fixed body. */
async function startOrigin(body) {
  const server = http.createServer((req, res) => {
    res.statusCode = 200
    res.setHeader('connection', 'close')
    res.end(body)
  })
  const port = await listen(server)
  return { server, port }
}

/** Loopback TLS origin using the committed self-signed `localhost` fixture. */
async function startTlsOrigin(body) {
  const server = https.createServer({ pfx: FIXTURE_PFX, passphrase: 'test' }, (req, res) => {
    res.statusCode = 200
    res.setHeader('connection', 'close')
    res.end(body)
  })
  const port = await listen(server)
  return { server, port }
}

/** Same listener, but it records method, headers, path and body per request. */
async function startRecordingTlsOrigin(body) {
  const seen = []
  const server = https.createServer({ pfx: FIXTURE_PFX, passphrase: 'test' }, (req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      res.statusCode = 200
      res.setHeader('connection', 'close')
      res.end(body)
    })
  })
  const port = await listen(server)
  return { server, port, seen }
}

after(() => {
  resetEgressCache()
  configureNetwork({})
})

test('readSystemProxy parses host:port and the ProxyOverride bypass list', async () => {
  resetEgressCache()
  const exec = fakeReg({ ProxyEnable: '0x1', ProxyServer: '127.0.0.1:7890', ProxyOverride: '<local>;*.local' })
  const info = await readSystemProxy({ execFile: exec })
  assert.deepEqual(info, { url: 'http://127.0.0.1:7890', source: 'system', bypass: '<local>;*.local' })
  assert.equal(exec.calls.length, 1)
  assert.equal(exec.calls[0].file, 'reg')
  assert.deepEqual(exec.calls[0].args, ['query', REG_KEY])
})

test('readSystemProxy understands http=…;https=… and prefers the https entry', async () => {
  const forward = await readSystemProxy({
    execFile: fakeReg({ ProxyEnable: '0x1', ProxyServer: 'http=127.0.0.1:7890;https=127.0.0.1:7891' }),
  })
  assert.equal(forward.url, 'http://127.0.0.1:7891')

  const reverse = await readSystemProxy({
    execFile: fakeReg({ ProxyEnable: '0x1', ProxyServer: 'https=10.0.0.5:8443;http=10.0.0.5:8080' }),
  })
  assert.equal(reverse.url, 'http://10.0.0.5:8443', 'the https= entry wins regardless of order')
})

test('ProxyEnable=0 returns null even when ProxyServer is set', async () => {
  const info = await readSystemProxy({
    execFile: fakeReg({ ProxyEnable: '0x0', ProxyServer: '127.0.0.1:7877', ProxyOverride: '' }),
  })
  assert.equal(info, null)
})

test('readSystemProxy never throws: reg failure, non-zero exit, non-Windows and bad values return null', async () => {
  const missing = Object.assign(new Error('spawn reg ENOENT'), { code: 'ENOENT' })
  assert.equal(await readSystemProxy({ execFile: fakeReg({}, missing) }), null)

  const failing = () => Promise.reject(Object.assign(new Error('Command failed: reg query'), { code: 1 }))
  assert.equal(await readSystemProxy({ execFile: failing }), null)

  let called = false
  const darwinExec = () => {
    called = true
    return Promise.resolve({ stdout: regOutput({ ProxyEnable: '0x1', ProxyServer: '127.0.0.1:7890' }) })
  }
  assert.equal(await readSystemProxy({ platform: 'darwin', execFile: darwinExec }), null)
  assert.equal(called, false, 'a non-Windows host must not run reg')

  assert.equal(
    await readSystemProxy({ execFile: fakeReg({ ProxyEnable: '0x1', ProxyServer: 'not a proxy' }) }),
    null,
  )
})

test('probeProxy sends CONNECT github.com:443 and accepts only a 2xx status', async () => {
  const fake = fakeSocket(CONNECT_OK)
  assert.equal(await probeProxy('127.0.0.1', 7890, 500, { connect: () => fake }), true)
  assert.equal(fake.written, 'CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n')

  const proxy = http.createServer()
  const state = { connects: 0, authority: '' }
  proxy.on('connect', (req, socket) => {
    state.connects += 1
    state.authority = String(req.url || '')
    socket.end(CONNECT_OK)
  })
  const port = await listen(proxy)
  try {
    assert.equal(await probeProxy('127.0.0.1', port, 1000), true)
    assert.equal(state.connects, 1)
    assert.equal(state.authority, 'github.com:443')
  } finally {
    await close(proxy)
  }

  const reject = http.createServer()
  reject.on('connect', (req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'))
  const rejectPort = await listen(reject)
  try {
    assert.equal(await probeProxy('127.0.0.1', rejectPort, 1000), false)
  } finally {
    await close(reject)
  }

  // TCP accepts but never speaks HTTP: exactly what a SOCKS-only listener on
  // 1080 does when it receives a CONNECT request.
  const socks = net.createServer((socket) => {
    socket.on('data', () => {
      /* swallow the HTTP bytes, SOCKS never answers them */
    })
  })
  const socksPort = await listen(socks)
  try {
    const startedAt = Date.now()
    assert.equal(await probeProxy('127.0.0.1', socksPort, 200), false)
    assert.ok(Date.now() - startedAt < 1500, 'the probe gave up on its own timeout')
  } finally {
    await close(socks)
  }

  const closed = http.createServer()
  const closedPort = await listen(closed)
  await close(closed)
  assert.equal(await probeProxy('127.0.0.1', closedPort, 300), false, 'a refused dial is not a proxy')
})

test('discoverLocalProxies keeps only CONNECT 2xx ports; SOCKS-only 1080 stays out', async () => {
  resetEgressCache()
  await refreshSystemProxy({
    execFile: fakeReg({ ProxyEnable: '0x0', ProxyServer: '127.0.0.1:7877', ProxyOverride: '' }),
    force: true,
  })
  assert.ok(LOCAL_PROXY_PORTS.includes(1080), '1080 is in the fixed probe list')

  const ports = await discoverLocalProxies({
    connect: fakeConnect({
      7890: CONNECT_OK,
      1080: 'HTTP/1.1 400 Bad Request\r\n\r\n',
    }),
    timeoutMs: 200,
    force: true,
  })
  assert.deepEqual(ports, [7890])
  assert.deepEqual(cachedLocalProxyPorts(), [7890])
  assert.equal(ports.includes(1080), false, 'a TCP-open SOCKS port must not enter the chain')
})

test('system-proxy and local-proxy backends sit before direct in the chain', async () => {
  resetEgressCache()
  await refreshSystemProxy({
    execFile: fakeReg({ ProxyEnable: '0x1', ProxyServer: '127.0.0.1:7890', ProxyOverride: '' }),
    force: true,
  })
  await discoverLocalProxies({
    connect: fakeConnect({ 7897: CONNECT_OK }),
    timeoutMs: 200,
    force: true,
  })
  configureNetwork({ networkMode: 'auto', proxyUrl: '', dohEndpoints: [], candidateIPs: {} })
  try {
    const ids = textBackendIds('https://github.com/trending')
    assert.ok(ids.includes('system-proxy'), `chain: ${ids.join(', ')}`)
    assert.ok(ids.includes('local-proxy-7897'), `chain: ${ids.join(', ')}`)
    assert.equal(ids.includes('local-proxy-1080'), false, `SOCKS-only 1080 entered: ${ids.join(', ')}`)
    assert.ok(ids.indexOf('system-proxy') < ids.indexOf('local-proxy-7897'), `chain: ${ids.join(', ')}`)
    assert.ok(ids.indexOf('local-proxy-7897') < ids.indexOf('direct'), `chain: ${ids.join(', ')}`)
    assert.equal(chooseProxy('https://github.com/trending', {}, { networkMode: 'auto' }).source, 'system')
  } finally {
    configureNetwork({})
  }
})

test('chooseProxy prefers config proxyUrl, then the system proxy, then the environment', async () => {
  resetEgressCache()
  const url = 'https://github.com/trending'
  const env = { HTTPS_PROXY: 'http://env-proxy.local:8080' }

  await refreshSystemProxy({
    execFile: fakeReg({ ProxyEnable: '0x1', ProxyServer: '127.0.0.1:7890', ProxyOverride: '' }),
    force: true,
  })
  const configured = chooseProxy(url, env, { networkMode: 'auto', proxyUrl: 'http://config.local:8888' })
  assert.equal(configured.mode, 'proxy')
  assert.equal(configured.proxy, 'http://config.local:8888')
  assert.equal(configured.source, 'config')

  const system = chooseProxy(url, env, { networkMode: 'auto' })
  assert.equal(system.proxy, 'http://127.0.0.1:7890')
  assert.equal(system.source, 'system')

  await refreshSystemProxy({
    execFile: fakeReg({ ProxyEnable: '0x0', ProxyServer: '127.0.0.1:7890', ProxyOverride: '' }),
    force: true,
  })
  assert.equal(chooseProxy(url, env, { networkMode: 'auto' }).source, 'env')
})

test('a system proxy discovered from fake reg output issues CONNECT and returns content', async () => {
  resetEgressCache()
  const body = 'trending-via-system-proxy'
  const origin = await startOrigin(body)
  const proxy = await startConnectProxy(origin.port, body)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('direct fetch disabled in this test')
  }
  try {
    const exec = fakeReg({
      ProxyEnable: '0x1',
      ProxyServer: `127.0.0.1:${proxy.port}`,
      ProxyOverride: '<local>',
    })
    await refreshSystemProxy({ execFile: exec, force: true })
    await discoverLocalProxies({
      connect: () => {
        throw new Error('no local proxy in this test')
      },
      timeoutMs: 100,
      force: true,
    })
    configureNetwork({
      networkMode: 'auto',
      proxyUrl: '',
      dohEndpoints: ['http://127.0.0.1:9/dns-query'],
      candidateIPs: {},
    })

    const result = await fetchText('http://github-trending.test/trending', { timeoutMs: 2000 })
    assert.equal(result.via, 'system-proxy')
    assert.equal(result.text, body)
    assert.equal(proxy.state.connects, 1)
    assert.equal(proxy.state.authorities[0], 'github-trending.test:80')
    assert.equal(exec.calls.length, 1, 'only the injected registry reader ran')
  } finally {
    globalThis.fetch = originalFetch
    configureNetwork({})
    resetEgressCache()
    await close(proxy.proxy)
    await close(origin.server)
  }
})

test('the configured proxyUrl backend also issues CONNECT and returns content', async () => {
  resetEgressCache()
  const body = 'trending-via-config-proxy'
  const origin = await startOrigin(body)
  const proxy = await startConnectProxy(origin.port, body)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('direct fetch disabled in this test')
  }
  try {
    const exec = fakeReg({ ProxyEnable: '0x0', ProxyServer: '127.0.0.1:7877', ProxyOverride: '' })
    await refreshSystemProxy({ execFile: exec, force: true })
    await discoverLocalProxies({
      connect: () => {
        throw new Error('no local proxy in this test')
      },
      timeoutMs: 100,
      force: true,
    })
    configureNetwork({
      networkMode: 'auto',
      proxyUrl: `http://127.0.0.1:${proxy.port}`,
      dohEndpoints: ['http://127.0.0.1:9/dns-query'],
      candidateIPs: {},
    })

    const result = await fetchText('http://github-trending.test/trending', { timeoutMs: 2000, budgetMs: 8000 })
    assert.equal(result.via, 'proxy')
    assert.equal(result.text, body)
    assert.equal(proxy.state.connects, 1)
    assert.equal(proxy.state.authorities[0], 'github-trending.test:80')
    assert.equal(exec.calls.length, 1, 'only the injected registry reader ran')
  } finally {
    globalThis.fetch = originalFetch
    configureNetwork({})
    resetEgressCache()
    await close(proxy.proxy)
    await close(origin.server)
  }
})

test('fetchLocalMitm loads a self-signed loopback service when given its CA', async () => {
  const body = 'local-mitm-ok'
  const { server, port } = await startTlsOrigin(body)
  try {
    // SNI stays "localhost" (the fixture SAN) while the dial goes to loopback.
    const result = await fetchLocalMitm('https://localhost/trending', FIXTURE_PEM, port)
    assert.equal(result.status, 200)
    assert.equal(result.text, body)
    assert.equal(result.via, 'local-mitm')
  } finally {
    await close(server)
  }
})

test('fetchLocalMitm keeps certificate verification on: without the CA the handshake fails', async () => {
  const { server, port } = await startTlsOrigin('must-not-be-served')
  try {
    await assert.rejects(
      () => fetchLocalMitm('https://localhost/trending', '', port),
      (error) => {
        assert.match(String(error?.code ?? error?.message ?? ''), /SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO|CERT/i)
        return true
      },
      'an empty CA must fall back to the public trust store and reject the self-signed fixture',
    )
  } finally {
    await close(server)
  }
})

test('fetchLocalMitm forwards method, headers and body to the intercepting listener', async () => {
  const { server, port, seen } = await startRecordingTlsOrigin('posted-ok')
  try {
    // SNI stays "localhost" (the fixture SAN) while the dial goes to loopback.
    const result = await fetchLocalMitm('https://localhost/trending', FIXTURE_PEM, port, {
      method: 'POST',
      headers: {
        'user-agent': 'dsh-github-trending/1.0',
        authorization: 'Bearer local-mitm-token',
        'content-type': 'application/json',
      },
      body: '{"probe":true}',
      timeoutMs: 3000,
    })
    assert.equal(result.status, 200)
    assert.equal(result.text, 'posted-ok')
    assert.equal(result.via, 'local-mitm')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].method, 'POST', 'the method reaches the listener')
    assert.equal(seen[0].url, '/trending')
    assert.equal(seen[0].headers['user-agent'], 'dsh-github-trending/1.0')
    assert.equal(seen[0].headers.authorization, 'Bearer local-mitm-token', 'the authorization header reaches the listener')
    assert.equal(seen[0].body, '{"probe":true}', 'the request body reaches the listener')
  } finally {
    await close(server)
  }
})

test('fetchText hands init to local-mitm; direct sees neither the CA nor an authorization header', async () => {
  resetEgressCache()
  await refreshSystemProxy({
    execFile: fakeReg({ ProxyEnable: '0x0', ProxyServer: '127.0.0.1:7877', ProxyOverride: '' }),
    force: true,
  })
  await discoverLocalProxies({
    connect: () => {
      throw new Error('no local proxy in this test')
    },
    timeoutMs: 50,
    force: true,
  })
  configureNetwork({
    networkMode: 'auto',
    proxyUrl: '',
    dohEndpoints: ['http://127.0.0.1:9/dns-query'],
    candidateIPs: {},
  })
  const directCalls = []
  let mitmInit = null
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    directCalls.push({ url: String(url), options })
    return { status: 200, text: async () => 'direct-ok' }
  }
  try {
    const headers = { 'user-agent': 'dsh-github-trending/1.0', authorization: 'Bearer dsh-egress-test' }
    const result = await fetchText('https://github.com/trending', {
      dnsLookup: async () => ['127.0.0.1'],
      method: 'POST',
      headers,
      body: '{"probe":true}',
      timeoutMs: 2000,
      budgetMs: 6000,
      localMitmCa: async () => FIXTURE_PEM,
      localMitmFetch: async (url, ca, port, init) => {
        mitmInit = init
        return { status: 200, text: 'via-local-mitm', url, via: 'local-mitm' }
      },
    })
    assert.equal(result.via, 'local-mitm')
    assert.equal(mitmInit.method, 'POST')
    assert.equal(mitmInit.body, '{"probe":true}')
    assert.deepEqual(mitmInit.headers, headers, 'the caller headers reach the local-mitm request')
    assert.ok(mitmInit.timeoutMs > 0 && mitmInit.timeoutMs <= 2000, 'the per-attempt timeout reaches local-mitm')
    assert.equal(directCalls.length, 0)

    // A public name never enters local-mitm; the direct request carries no CA
    // and no authorization header of its own.
    const direct = await fetchText('https://github.com/trending', {
      dnsLookup: async () => ['203.0.113.7'],
      timeoutMs: 2000,
      budgetMs: 6000,
    })
    assert.equal(direct.via, 'direct')
    assert.equal(directCalls.length, 1)
    assert.equal(Object.prototype.hasOwnProperty.call(directCalls[0].options, 'ca'), false, 'the CA stays out of direct')
    const sentHeaders = directCalls[0].options.headers ?? {}
    assert.equal(
      Object.keys(sentHeaders).some((key) => key.toLowerCase() === 'authorization'),
      false,
      'no backend outside local-mitm invents an authorization header',
    )
  } finally {
    globalThis.fetch = originalFetch
    configureNetwork({})
    resetEgressCache()
  }
})

test('ensureCaPem exports only the matching root, caches it and re-exports when forced', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-system-ca-'))
  const cachePath = path.join(dir, 'nested', 'ca.pem')
  let probes = 0
  const probe = async () => {
    probes += 1
    return {
      fingerprint256: 'AA:BB:CC:DD',
      subject: 'CN=SteamTools Certificate',
      leafPem: '-----BEGIN CERTIFICATE-----\nTk9URU5PVUdI\n-----END CERTIFICATE-----',
    }
  }
  try {
    const unrelated = await ensureCaPem('github.com', {
      cachePath,
      probe,
      listRoots: async () => [
        {
          subject: 'CN=Some Unrelated Root',
          fingerprint256: '11:22:33:44',
          pem: '-----BEGIN CERTIFICATE-----\nTk9UQUNFUlQ=\n-----END CERTIFICATE-----',
        },
      ],
    })
    assert.equal(unrelated, null, 'a root with a different fingerprint must not be trusted')
    assert.equal(existsSync(cachePath), false, 'nothing may be cached when no root matches')

    const options = {
      cachePath,
      probe,
      listRoots: async () => [
        { subject: 'CN=SteamTools Certificate, O=BeyondDimension', fingerprint256: 'aa:bb:cc:dd', pem: FIXTURE_PEM },
      ],
    }
    const first = await ensureCaPem('github.com', options)
    assert.equal(first, FIXTURE_PEM)
    assert.equal(probes, 2, 'the mismatch probe and the matching probe each ran once')
    assert.match(readFileSync(cachePath, 'utf8'), /BEGIN CERTIFICATE/)

    const second = await ensureCaPem('github.com', options)
    assert.equal(second, FIXTURE_PEM)
    assert.equal(probes, 2, 'a cache younger than seven days is reused without probing again')

    const forced = await ensureCaPem('github.com', { ...options, force: true })
    assert.equal(forced, FIXTURE_PEM)
    assert.equal(probes, 3, 'force drops the cache and exports once more')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureCaPem verifies the signing root when the listener omits its issuer certificate', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-system-ca-'))
  const cachePath = path.join(dir, 'ca.pem')
  try {
    const pem = await ensureCaPem('localhost', {
      cachePath,
      // No `fingerprint256`: real interceptors usually send the leaf only.
      probe: async () => ({ subject: 'CN=localhost', leafPem: FIXTURE_PEM }),
      listRoots: async () => [
        {
          subject: 'CN=Some Unrelated Root',
          fingerprint256: '00:11:22:33',
          pem: '-----BEGIN CERTIFICATE-----\nTk9UQUNFUlQ=\n-----END CERTIFICATE-----',
        },
        { subject: 'CN=localhost', fingerprint256: '44:55:66:77', pem: FIXTURE_PEM },
      ],
    })
    assert.equal(pem, FIXTURE_PEM, 'the root that provably signed the leaf is selected')
    assert.match(readFileSync(cachePath, 'utf8'), /BEGIN CERTIFICATE/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ca only reaches the local-mitm request; direct never sees it', async () => {
  resetEgressCache()
  await refreshSystemProxy({
    execFile: fakeReg({ ProxyEnable: '0x0', ProxyServer: '127.0.0.1:7877', ProxyOverride: '' }),
    force: true,
  })
  await discoverLocalProxies({
    connect: () => {
      throw new Error('no local proxy in this test')
    },
    timeoutMs: 50,
    force: true,
  })
  configureNetwork({
    networkMode: 'auto',
    proxyUrl: '',
    dohEndpoints: ['http://127.0.0.1:9/dns-query'],
    candidateIPs: {},
  })
  const directCalls = []
  const mitmCalls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    directCalls.push({ url: String(url), options })
    return { status: 200, text: async () => 'direct-ok' }
  }
  try {
    const result = await fetchText('https://github.com/trending', {
      dnsLookup: async () => ['127.0.0.1'],
      timeoutMs: 2000,
      budgetMs: 6000,
      localMitmCa: async (host) => {
        assert.equal(host, 'github.com')
        return FIXTURE_PEM
      },
      localMitmFetch: async (url, ca, port) => {
        mitmCalls.push({ url, ca, port })
        return { status: 200, text: 'via-local-mitm', url, via: 'local-mitm' }
      },
    })
    assert.equal(result.via, 'local-mitm')
    assert.equal(result.text, 'via-local-mitm')
    assert.equal(directCalls.length, 0, 'the loopback precheck skipped direct before it ran')
    assert.equal(mitmCalls.length, 1)
    assert.equal(mitmCalls[0].ca, FIXTURE_PEM, 'the CA is passed to the local-mitm request')
    assert.equal(mitmCalls[0].port, 443)

    // A public resolution keeps local-mitm out of the chain; the direct
    // backend's fetch options carry no CA at all.
    const direct = await fetchText('https://github.com/trending', {
      dnsLookup: async () => ['203.0.113.7'],
      timeoutMs: 2000,
      budgetMs: 6000,
      localMitmCa: async () => FIXTURE_PEM,
      localMitmFetch: async () => {
        throw new Error('local-mitm must not run for a public address')
      },
    })
    assert.equal(direct.via, 'direct')
    assert.equal(directCalls.length, 1)
    assert.equal(Object.prototype.hasOwnProperty.call(directCalls[0].options, 'ca'), false)
    assert.equal(existsSync(FIXTURE_DIR), true, 'the committed TLS fixture is present')
    assert.equal(textBackendIds('https://github.com/trending').includes('local-mitm'), false)
  } finally {
    globalThis.fetch = originalFetch
    configureNetwork({})
    resetEgressCache()
  }
})

test('the transport budget defaults to 25000ms and the report window is budget - 250', async () => {
  configureNetwork({})
  try {
    assert.equal(currentTotalBudgetMs(), 25000, 'the default budget is 25000ms')
    assert.equal(reportFetchWindowMs(), 24750, 'the report window is the budget minus the 250ms margin')

    configureNetwork({ totalBudgetMs: 12000 })
    assert.equal(currentTotalBudgetMs(), 12000)
    assert.equal(reportFetchWindowMs(), 11750, 'a configured budget moves the window with it')

    configureNetwork({ totalBudgetMs: 5000 })
    assert.equal(reportFetchWindowMs(), 4750, 'the minimum budget still leaves the margin')
  } finally {
    configureNetwork({})
  }
})

test('forceDirect keeps the chain to direct and skips the loopback precheck', async () => {
  resetEgressCache()
  await refreshSystemProxy({
    execFile: fakeReg({ ProxyEnable: '0x1', ProxyServer: '127.0.0.1:7890', ProxyOverride: '' }),
    force: true,
  })
  await discoverLocalProxies({ connect: fakeConnect({ 7897: CONNECT_OK }), timeoutMs: 200, force: true })
  configureNetwork({ networkMode: 'auto', proxyUrl: '', forceDirect: true })
  const originalFetch = globalThis.fetch
  let prechecks = 0
  globalThis.fetch = async (url) => ({ status: 200, text: async () => `direct-forced:${url}`, url })
  try {
    assert.deepEqual(
      textBackendIds('https://github.com/trending'),
      ['direct'],
      'a forced direct chain has exactly one backend even with a system proxy and a local proxy cached',
    )
    const result = await fetchText('https://github.com/trending', {
      dnsLookup: async () => {
        prechecks += 1
        return ['127.0.0.1']
      },
      timeoutMs: 2000,
      localMitmCa: async () => {
        throw new Error('local-mitm must not run under forceDirect')
      },
    })
    assert.equal(result.via, 'direct')
    assert.match(result.text, /^direct-forced:/)
    assert.equal(prechecks, 0, 'the loopback precheck must be skipped so direct is not dropped')
  } finally {
    globalThis.fetch = originalFetch
    configureNetwork({})
    resetEgressCache()
  }
})

test('networkMode=manual keeps only the proxyUrl backend in the chain', async () => {
  resetEgressCache()
  await refreshSystemProxy({
    execFile: fakeReg({ ProxyEnable: '0x1', ProxyServer: '127.0.0.1:7890', ProxyOverride: '' }),
    force: true,
  })
  await discoverLocalProxies({ connect: fakeConnect({ 7897: CONNECT_OK }), timeoutMs: 200, force: true })
  configureNetwork({ networkMode: 'manual', proxyUrl: 'http://127.0.0.1:8888' })
  try {
    assert.deepEqual(
      textBackendIds('https://github.com/trending'),
      ['proxy'],
      'manual routing must not fall back to the discovered system or local proxy',
    )
  } finally {
    configureNetwork({})
    resetEgressCache()
  }
})

test('caPath points systemCa at the configured PEM cache', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-ca-path-'))
  const caPath = path.join(dir, 'custom-ca.pem')
  writeFileSync(caPath, `${FIXTURE_PEM}\n`)
  resetEgressCache()
  await refreshSystemProxy({
    execFile: fakeReg({ ProxyEnable: '0x0', ProxyServer: '127.0.0.1:7877', ProxyOverride: '' }),
    force: true,
  })
  await discoverLocalProxies({
    connect: () => {
      throw new Error('no local proxy in this test')
    },
    timeoutMs: 50,
    force: true,
  })
  configureNetwork({ networkMode: 'auto', caPath })
  try {
    assert.equal(currentCaPath(), caPath)
    const captures = []
    const result = await fetchText('https://github.com/trending', {
      dnsLookup: async () => ['127.0.0.1'],
      timeoutMs: 2000,
      budgetMs: 6000,
      localMitmFetch: async (url, ca, port) => {
        captures.push({ url, ca, port })
        return { status: 200, text: 'via-configured-ca', url, via: 'local-mitm' }
      },
    })
    assert.equal(result.via, 'local-mitm', 'the loopback name still selects the local-mitm backend')
    assert.equal(result.text, 'via-configured-ca')
    assert.equal(captures.length, 1)
    assert.equal(captures[0].ca, FIXTURE_PEM, 'ensureCaPem read the CA from the configured caPath')
    assert.equal(captures[0].port, 443)
  } finally {
    configureNetwork({})
    resetEgressCache()
    rmSync(dir, { recursive: true, force: true })
  }
})
