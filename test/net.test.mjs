#!/usr/bin/env node
/**
 * Offline tests for the network layer (Task-1).
 *
 * Not a single request leaves this machine: the DoH fixtures are served from a
 * loopback HTTP server, the CONNECT tunnel is a loopback proxy, and the failure
 * paths use a closed loopback port. Run with:
 *
 *   node build.mjs && node test/net.test.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ADDRESS_ATTEMPT_TIMEOUT_MS,
  ADDRESS_TOTAL_BUDGET_MS,
  DEFAULT_DOH_ENDPOINTS,
  candidateAddresses,
  chooseProxy,
  createAddressLookup,
  fetchViaAddress,
  fetchViaAddresses,
  requestViaProxy,
  resolveDoh,
} from '../lib/net.js'
import { configureNetwork, currentNetworkConfig, fetchText, registerTextBackend } from '../lib/http.js'
import { clearReportCache, getReport } from '../lib/report.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureDir = path.join(here, 'fixtures', 'net')
const rootDir = path.resolve(here, '..')

async function fixture(name) {
  return JSON.parse(await readFile(path.join(fixtureDir, name), 'utf8'))
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function close(server) {
  return new Promise((resolve) => server.close(resolve))
}

function base(port) {
  return `http://127.0.0.1:${port}`
}

const outcomes = []

async function test(name, fn) {
  try {
    await fn()
    outcomes.push({ name, ok: true })
    console.log(`ok - ${name}`)
  } catch (error) {
    outcomes.push({ name, ok: false, error })
    console.log(`not ok - ${name}`)
    console.log(String((error && error.stack) || error).replace(/^/gm, '  '))
  }
}

async function startDohServer() {
  const cloudflare = await fixture('doh-cloudflare.json')
  const google = await fixture('doh-google.json')
  const alidns = await fixture('doh-alidns.json')
  const server = http.createServer((req, res) => {
    const url = new URL(String(req.url || '/'), 'http://127.0.0.1')
    if (url.pathname === '/dns-query') {
      res.setHeader('content-type', 'application/dns-json')
      res.end(JSON.stringify(cloudflare))
      return
    }
    if (url.pathname === '/resolve') {
      res.setHeader('content-type', 'application/dns-json')
      res.end(JSON.stringify(google))
      return
    }
    if (url.pathname === '/alidns') {
      // The endpoint template must have expanded `{host}` / `type=A` before the
      // resolver reaches the wire; otherwise answer 400 so the test fails loud.
      if (url.searchParams.get('name') !== 'github.com' || url.searchParams.get('type') !== 'A') {
        res.statusCode = 400
        res.end('bad query')
        return
      }
      res.setHeader('content-type', 'application/dns-json')
      res.end(JSON.stringify(alidns))
      return
    }
    if (url.pathname === '/broken') {
      res.statusCode = 503
      res.end('resolver unavailable')
      return
    }
    res.statusCode = 404
    res.end('missing')
  })
  const port = await listen(server)
  return { server, port }
}

/** Start an HTTP server that replies with one fixed body. */
async function startFixedServer(body, status = 200) {
  const server = http.createServer((req, res) => {
    res.statusCode = status
    res.end(body)
  })
  const port = await listen(server)
  return { server, port }
}

/**
 * Loopback CONNECT proxy. Counts the tunnels it opened so the test can prove the
 * request really went through the proxy instead of dialling the origin directly.
 */
async function startConnectProxy() {
  const state = { connects: 0 }
  const proxy = http.createServer((req, res) => {
    res.statusCode = 405
    res.end('CONNECT only')
  })
  proxy.on('connect', (req, clientSocket, head) => {
    state.connects += 1
    const [host, port] = String(req.url || '').split(':')
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
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

async function main() {
  const doh = await startDohServer()
  const fixed = await startFixedServer('tunnel-ok')
  const proxy = await startConnectProxy()

  try {
    await test('resolveDoh parses Cloudflare A records and de-duplicates', async () => {
      const records = await resolveDoh('github.com', {
        endpoints: [`${base(doh.port)}/dns-query`],
      })
      assert.deepEqual(records, ['140.82.112.3', '140.82.113.3'])
    })

    await test('resolveDoh falls back to the next endpoint after a failure', async () => {
      const records = await resolveDoh('api.github.com', {
        endpoints: [`${base(doh.port)}/broken`, `${base(doh.port)}/resolve`],
      })
      assert.deepEqual(records, ['140.82.112.6', '140.82.113.6'])
    })

    await test('resolveDoh filters answers by host and throws when every endpoint fails', async () => {
      const raw = await resolveDoh('raw.githubusercontent.com', {
        endpoints: [`${base(doh.port)}/resolve`],
      })
      assert.deepEqual(raw, ['185.199.108.133'])
      await assert.rejects(
        () => resolveDoh('github.com', { endpoints: [`${base(doh.port)}/broken`] }),
        /DoH resolution failed/,
      )
    })

    await test('resolveDoh parses an AliDNS-shaped answer and expands {host}', async () => {
      const records = await resolveDoh('github.com', {
        endpoints: [`${base(doh.port)}/alidns?name={host}&type=A`],
      })
      assert.deepEqual(records, ['20.205.243.166'], 'AliDNS Answer[].data yielding one A record, de-duplicated')
    })

    await test('resolveDoh stops at the total budget instead of summing per-endpoint timeouts', async () => {
      const seen = []
      // A fetch that never answers and ignores its AbortSignal: exactly the
      // "network is down, socket hangs" case the budget must bound on its own.
      const hangingFetch = (url) => {
        seen.push(String(url))
        return new Promise(() => {})
      }
      const started = Date.now()
      await assert.rejects(
        () =>
          resolveDoh('github.com', {
            endpoints: [
              'https://doh-a.invalid/one',
              'https://doh-b.invalid/two',
              'https://doh-c.invalid/three',
              'https://doh-d.invalid/four',
            ],
            timeoutMs: 120,
            totalBudgetMs: 300,
            fetchImpl: hangingFetch,
          }),
        /DoH resolution failed/,
      )
      const elapsed = Date.now() - started
      assert.ok(elapsed < 1200, `DoH round must respect its total budget, took ${elapsed}ms`)
      assert.ok(seen.length >= 1 && seen.length <= 3, `only budgeted endpoints may be tried, saw ${seen.length}`)
    })

    await test('fetchViaAddresses stops at the round budget and names attempts + elapsed', async () => {
      let clock = 0
      const seen = []
      // Fake clock + instantly failing dial: proves the round stops on wall
      // clock accounting, not on the per-address socket timeout.
      await assert.rejects(
        () =>
          fetchViaAddresses(
            'https://github.com/trending?since=daily',
            ['203.0.113.1', '203.0.113.2', '203.0.113.3'],
            {},
            {
              timeoutMs: 2500,
              totalBudgetMs: 6000,
              now: () => clock,
              attempt: async (_url, ip) => {
                seen.push(ip)
                clock += 3000
                throw new Error('dial timed out')
              },
            },
          ),
        /已尝试 2 个地址、总耗时 6000 ms/,
      )
      assert.deepEqual(seen, ['203.0.113.1', '203.0.113.2'], 'third address is skipped once the budget is spent')
    })

    await test('fetchViaAddresses bounds a dial that ignores the abort signal', async () => {
      const seen = []
      const started = Date.now()
      await assert.rejects(
        () =>
          fetchViaAddresses(
            'https://example.invalid/unresponsive',
            ['203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.4'],
            {},
            {
              timeoutMs: 100,
              totalBudgetMs: 250,
              attempt: async (_url, ip) => {
                seen.push(ip)
                return new Promise(() => {})
              },
            },
          ),
        /已尝试 3 个地址、总耗时 \d+ ms/,
      )
      const elapsed = Date.now() - started
      assert.ok(elapsed < 900, `candidate round must stay near 250ms, took ${elapsed}ms`)
      assert.equal(seen.length, 3, 'only budgeted addresses are dialled')
    })

    await test('DEFAULT_DOH_ENDPOINTS puts AliDNS and doh.pub first', () => {
      assert.deepEqual([...DEFAULT_DOH_ENDPOINTS], [
        'https://dns.alidns.com/resolve?name={host}&type=A',
        'https://doh.pub/dns-query?name={host}&type=A',
        'https://1.1.1.1/dns-query?name={host}&type=A',
        'https://8.8.8.8/resolve?name={host}&type=A',
      ])
    })

    await test('candidateAddresses de-duplicates built-in, configured and env candidates', async () => {
      const data = await fixture('candidates.json')
      const list = candidateAddresses(data.host, { candidateIPs: data.config })
      assert.equal(new Set(list).size, list.length, 'addresses must be unique')
      assert.equal(list[0], data.builtinFirst, 'built-in address stays first')
      for (const ip of data.expectedIncludes) assert.ok(list.includes(ip), `missing ${ip}`)
      assert.ok(!list.includes('not-an-ip'), 'invalid values are dropped')

      const second = candidateAddresses(data.host2, { candidateIPs: data.config })
      for (const ip of data.host2ExpectedIncludes) assert.ok(second.includes(ip), `missing ${ip}`)

      const previous = process.env.GITHUB_TRENDING_IP
      process.env.GITHUB_TRENDING_IP = data.envIp
      try {
        assert.ok(
          candidateAddresses(data.host, {}).includes(data.envIp),
          'GITHUB_TRENDING_IP is kept as one candidate',
        )
      } finally {
        if (previous === undefined) delete process.env.GITHUB_TRENDING_IP
        else process.env.GITHUB_TRENDING_IP = previous
      }

      assert.deepEqual(candidateAddresses('127.0.0.1', {}), [], 'loopback needs no candidate')
    })

    await test('chooseProxy implements auto / manual / off and NO_PROXY matching', async () => {
      const url = 'https://github.com/foo/bar'
      const env = { HTTPS_PROXY: 'http://proxy.local:8080' }

      const auto = chooseProxy(url, env, { networkMode: 'auto' })
      assert.equal(auto.mode, 'proxy')
      assert.equal(auto.proxy, 'http://proxy.local:8080')
      assert.equal(auto.source, 'env')

      assert.equal(chooseProxy(url, { ...env, NO_PROXY: '.github.com' }, { networkMode: 'auto' }).mode, 'direct')
      assert.equal(chooseProxy(url, { ...env, NO_PROXY: '*' }, { networkMode: 'auto' }).mode, 'direct')
      assert.equal(
        chooseProxy(url, { ...env, NO_PROXY: 'example.com,github.com:443' }, { networkMode: 'auto' }).mode,
        'direct',
        'host:port entries match',
      )
      assert.equal(
        chooseProxy(url, { ...env, NO_PROXY: 'github.com:8443' }, { networkMode: 'auto' }).mode,
        'proxy',
        'port mismatch does not match',
      )
      assert.equal(
        chooseProxy('https://raw.githubusercontent.com/a/b', { ...env, NO_PROXY: 'github.com' }, { networkMode: 'auto' })
          .mode,
        'proxy',
        'suffix hosts are not matched by an unrelated entry',
      )

      const manual = chooseProxy(url, env, { networkMode: 'manual', proxyUrl: 'http://manual.local:7890' })
      assert.equal(manual.mode, 'proxy')
      assert.equal(manual.proxy, 'http://manual.local:7890', 'manual ignores HTTPS_PROXY')
      assert.equal(chooseProxy(url, env, { networkMode: 'manual' }).mode, 'direct', 'manual without proxyUrl is direct')

      assert.equal(
        chooseProxy(url, env, { networkMode: 'off', proxyUrl: 'http://manual.local:7890' }).mode,
        'direct',
        'off ignores both env and config proxies',
      )
    })

    await test('candidate rounds allow 4s per address and 12s per round', () => {
      assert.equal(ADDRESS_ATTEMPT_TIMEOUT_MS, 4000)
      assert.equal(ADDRESS_TOTAL_BUDGET_MS, 12000)
    })

    await test('fetchText skips direct when the DNS precheck resolves to loopback', async () => {
      configureNetwork({ networkMode: 'off', proxyUrl: '', candidateIPs: {} })
      const calls = []
      const dispose = registerTextBackend('after-dns-skip', async (url) => {
        calls.push('after-dns-skip')
        return { status: 200, text: 'fallback-ok', url, via: 'after-dns-skip', attempts: 1 }
      })
      const dnsLookup = async () => ['127.0.0.1']
      try {
        const result = await fetchText('http://dns-loopback.test/trending', { dnsLookup })
        assert.equal(result.via, 'after-dns-skip')
        assert.equal(result.text, 'fallback-ok')
        assert.equal(calls.length, 1, 'the fallback ran without a direct TLS attempt')
        assert.equal(result.attempts, 1, 'the skipped direct does not count as a backend attempt')
      } finally {
        dispose()
      }
      await assert.rejects(
        () => fetchText('http://dns-loopback.test/trending', { dnsLookup }),
        /direct: skipped \(dns resolves to loopback\)/,
        'the failure text names the skipped direct and why',
      )
    })

    await test('fetchText keeps direct when the DNS precheck resolves to a public address', async () => {
      configureNetwork({ networkMode: 'off', proxyUrl: '', candidateIPs: {} })
      const calls = []
      const dispose = registerTextBackend('after-public-dns', async (url) => {
        calls.push('after-public-dns')
        return { status: 200, text: 'fallback-ok', url, via: 'after-public-dns', attempts: 1 }
      })
      try {
        const result = await fetchText('http://dns-public.test/trending', {
          dnsLookup: async () => ['203.0.113.7'],
          timeoutMs: 800,
          budgetMs: 3000,
        })
        assert.equal(result.via, 'after-public-dns')
        assert.equal(result.attempts, 2, 'direct ran first and failed, then the fallback answered')
        assert.equal(calls.length, 1)
      } finally {
        dispose()
      }
    })

    await test('getReport retries once after a network error and returns normal data', async () => {
      clearReportCache()
      let calls = 0
      const fetchBoard = async () => {
        calls += 1
        if (calls === 1) {
          throw new Error(
            'no transport could load https://github.com/trending (direct: skipped (dns resolves to loopback); doh-ip: no candidate address answered) after 6000ms',
          )
        }
        return {
          repos: Array.from({ length: 60 }, (_, index) => ({
            rank: index + 1,
            owner: 'acme',
            name: 'repo-' + index,
            fullName: 'acme/repo-' + index,
            url: 'https://github.com/acme/repo-' + index,
            description: 'repo ' + index,
            language: 'TypeScript',
            languageColor: null,
            stars: 10,
            forks: 1,
            delta: 2,
            contributors: [],
          })),
          via: 'doh-ip',
        }
      }
      const report = await getReport({
        since: 'daily',
        limit: 50,
        focusCount: 3,
        refresh: true,
        enrichCount: 0,
        readmeCount: 0,
        fetchBoard,
        retryDelayMs: 10,
      })
      assert.equal(calls, 2, 'the first failed attempt was retried')
      assert.equal(report.error, undefined, 'a successful retry carries no error payload')
      assert.equal(report.repos.length, 50)
      assert.equal(report.networkStatus, 'fallback')
    })

    await test('getReport reports error.attempts after both attempts fail', async () => {
      clearReportCache()
      let calls = 0
      const fetchBoard = async () => {
        calls += 1
        throw new Error(
          'no transport could load https://github.com/trending (direct: skipped (dns resolves to loopback); doh-ip: no candidate address answered) after 6000ms',
        )
      }
      const report = await getReport({
        since: 'daily',
        limit: 50,
        refresh: true,
        enrichCount: 0,
        readmeCount: 0,
        timeoutMs: 2000,
        retryDelayMs: 20,
        fetchBoard,
      })
      assert.equal(calls, 2, 'exactly two attempts were made')
      assert.equal(report.shortfallReason, 'network-error')
      assert.equal(report.error.class, 'network')
      assert.equal(report.error.attempts.length, 2)
      assert.deepEqual(report.error.attempts.map((entry) => entry.attempt), [1, 2])
      for (const attempt of report.error.attempts) {
        assert.ok(attempt.ms >= 0)
        assert.ok(Array.isArray(attempt.reasons) && attempt.reasons.length >= 2, 'each backend has a reason summary')
      }
      assert.ok(report.durationMs <= 2000, `the retry window stays bounded, took ${report.durationMs}ms`)
    })

    await test('fetchText switches backends on failure and reports via/attempts', async () => {
      configureNetwork({ networkMode: 'off', proxyUrl: '', candidateIPs: {} })
      const probe = http.createServer()
      const deadPort = await listen(probe)
      await close(probe)
      const url = `${base(deadPort)}/unreachable`

      const disposeBad = registerTextBackend('always-fail', async () => {
        throw new Error('backend down')
      })
      const disposeGood = registerTextBackend('second-good', async () => ({
        status: 200,
        text: 'switched',
        url,
        via: 'second-good',
        attempts: 1,
      }))
      try {
        const result = await fetchText(url)
        assert.equal(result.via, 'second-good')
        assert.equal(result.text, 'switched')
        assert.equal(result.attempts, 3, 'direct + always-fail + second-good were tried')
      } finally {
        disposeBad()
        disposeGood()
      }
      await assert.rejects(() => fetchText(url), /no transport could load/)
    })

    await test('fetchText direct backend forwards method/body and counts one attempt', async () => {
      const echo = http.createServer((req, res) => {
        let body = ''
        req.on('data', (chunk) => {
          body += chunk
        })
        req.on('end', () => {
          res.statusCode = 200
          res.end(JSON.stringify({ method: req.method, body, host: req.headers.host }))
        })
      })
      const port = await listen(echo)
      configureNetwork({ networkMode: 'off', proxyUrl: '', candidateIPs: {} })
      try {
        const result = await fetchText(`${base(port)}/echo`, {
          method: 'POST',
          body: 'hello-body',
          headers: { 'x-test': 'yes' },
        })
        assert.equal(result.via, 'direct')
        assert.equal(result.attempts, 1)
        const payload = JSON.parse(result.text)
        assert.equal(payload.method, 'POST')
        assert.equal(payload.body, 'hello-body')
        assert.equal(payload.host, `127.0.0.1:${port}`)
      } finally {
        await close(echo)
      }
    })

    await test('lookup hook answers the autoSelectFamily (all:true) form with an array', () => {
      const lookup = createAddressLookup('203.0.113.7')
      const calls = []
      // Node's net.connect calls one of these three shapes; autoSelectFamily
      // (the default on modern Node) uses the first one.
      lookup('github.com', { all: true }, (...args) => calls.push(args))
      lookup('github.com', { family: 4 }, (...args) => calls.push(args))
      lookup('github.com', (...args) => calls.push(args))
      assert.deepEqual(calls[0], [null, [{ address: '203.0.113.7', family: 4 }]])
      assert.deepEqual(calls[1], [null, '203.0.113.7', 4])
      assert.deepEqual(calls[2], [null, '203.0.113.7', 4])
      assert.throws(() => createAddressLookup('not-an-ip'), /not a valid IP address/)
    })

    await test('fetchViaAddress dials the supplied loopback address', async () => {
      const result = await fetchViaAddress(`${base(fixed.port)}/via-ip`, '127.0.0.1')
      assert.equal(result.status, 200)
      assert.equal(result.text, 'tunnel-ok')
      assert.equal(result.via, 'doh-ip')
      // A hostname (not an IP literal) is the path that actually exercises the
      // custom `lookup` hook, including Node's all:true calling convention.
      const byName = await fetchViaAddress(`http://localhost:${fixed.port}/via-name`, '127.0.0.1')
      assert.equal(byName.status, 200)
      assert.equal(byName.text, 'tunnel-ok')
      await assert.rejects(() => fetchViaAddress(`${base(fixed.port)}/`, 'not-an-ip'), /not a valid IP address/)
    })

    await test('requestViaProxy opens a CONNECT tunnel and returns 200', async () => {
      const started = proxy.state.connects
      const result = await requestViaProxy(`${base(fixed.port)}/hello`, `http://127.0.0.1:${proxy.port}`)
      assert.equal(result.status, 200)
      assert.equal(result.text, 'tunnel-ok')
      assert.equal(result.via, 'proxy')
      assert.equal(proxy.state.connects, started + 1, 'origin was reached through the CONNECT proxy')
    })

    await test('requestViaProxy rejects when the proxy refuses CONNECT', async () => {
      const rejecting = http.createServer((req, res) => {
        res.statusCode = 405
        res.end('no')
      })
      rejecting.on('connect', (req, socket) => {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      })
      const port = await listen(rejecting)
      try {
        await assert.rejects(
          () => requestViaProxy(`${base(fixed.port)}/hello`, `http://127.0.0.1:${port}`),
          /CONNECT failed/,
        )
      } finally {
        await close(rejecting)
      }
    })

    await test('network configuration is applied to the transport layer', async () => {
      configureNetwork({
        networkMode: 'manual',
        proxyUrl: 'http://127.0.0.1:9',
        dohEndpoints: [`${base(doh.port)}/dns-query`],
        candidateIPs: { 'github.com': ['203.0.113.99'] },
      })
      const config = currentNetworkConfig()
      assert.equal(config.networkMode, 'manual')
      assert.equal(config.proxyUrl, 'http://127.0.0.1:9')
      assert.deepEqual(config.dohEndpoints, [`${base(doh.port)}/dns-query`])
      assert.deepEqual(config.candidateIPs['github.com'], ['203.0.113.99'])
      configureNetwork({})
      assert.equal(currentNetworkConfig().networkMode, 'auto')
      assert.deepEqual(currentNetworkConfig().dohEndpoints, [...DEFAULT_DOH_ENDPOINTS])
    })

    await test('package.json has no runtime dependencies', async () => {
      const pkg = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'))
      assert.deepEqual(Object.keys(pkg.dependencies || {}), [], 'no runtime dependency may be added')
    })
  } finally {
    configureNetwork({})
    await close(proxy.proxy)
    await close(fixed.server)
    await close(doh.server)
  }

  const failed = outcomes.filter((entry) => !entry.ok)
  console.log(`\n${outcomes.length - failed.length}/${outcomes.length} network tests passed`)
  if (failed.length > 0) {
    console.log(`failed: ${failed.map((entry) => entry.name).join(', ')}`)
    process.exitCode = 1
  }
}

await main()
