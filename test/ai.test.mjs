#!/usr/bin/env node
/**
 * Offline tests for Phase 2 `/ai`: AI match scoring, weighted sorting and the
 * GitHub Search fallback.
 *
 * No test may resolve a real external host. Model traffic goes to a loopback
 * `node:http` fake server (injected through `fetchImpl` at module level and
 * through `aiBaseURL` at route level); GitHub Search traffic is rewritten to a
 * second loopback server. The rewrite throws for any other external hostname so
 * an accidental real request fails the test instead of leaving the machine.
 *
 * Run with:
 *
 *   node build.mjs && node test/ai.test.mjs --fixture test/fixtures/ai/chat-score.json
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  AI_TIMEOUT_MS,
  AiNotConfiguredError,
  MAX_REASON_CHARS,
  SCORE_SYSTEM_PROMPT,
  aiStatus,
  scoreRepos,
  sortByWeights,
} from '../lib/ai.js'
import {
  SEARCH_ENDPOINT,
  searchRepos,
  searchUrl,
} from '../lib/search.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(here, '..')
const fixtureDir = path.join(here, 'fixtures', 'ai')
const scoreFixture = JSON.parse(readFileSync(path.join(fixtureDir, 'chat-score.json'), 'utf8'))
const searchFixture = JSON.parse(readFileSync(path.join(fixtureDir, 'search.json'), 'utf8'))
const missingKeyFile = path.join(os.tmpdir(), `dsh-github-trending-ai-no-key-${process.pid}`)

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

function jsonResponse(res, payload, status = 200) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(body)
}

function chatPayload(items) {
  return { choices: [{ message: { content: JSON.stringify({ items }) } }] }
}

/**
 * Start a loopback JSON server. `handler` runs after the body is parsed and the
 * request recorded so a test can answer, delay or fail.
 */
async function startFakeServer(handler) {
  const requests = []
  const server = http.createServer(function (req, res) {
    const chunks = []
    req.on('data', function (chunk) {
      chunks.push(chunk)
    })
    req.on('end', function () {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        body = null
      }
      const record = { method: req.method, url: req.url, headers: req.headers, body, raw }
      requests.push(record)
      Promise.resolve(handler({ req, res, body, record })).catch(function () {
        try {
          res.statusCode = 500
          res.end('handler failed')
        } catch {
          /* socket gone */
        }
      })
    })
  })
  await new Promise(function (resolve, reject) {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close() {
      return new Promise(function (resolve) {
        try {
          server.closeAllConnections?.()
        } catch {
          /* older node */
        }
        server.close(resolve)
      })
    },
  }
}

/** The prompt the route sends lives in the second chat message. */
function promptOf(body) {
  try {
    return JSON.parse(body.messages[1].content).prompt
  } catch {
    return ''
  }
}

const REPO_FIXTURE = {
  since: 'daily',
  language: null,
  generatedAt: '2026-11-08T06:00:00.000Z',
  focusCount: 3,
  cache: 'hit',
  durationMs: 12,
  shortfall: 0,
  shortfallReason: null,
  apiCalls: 0,
  enrichedCount: 5,
  lastVia: 'direct',
  networkStatus: 'direct',
  catalog: [],
  customBoards: [],
  deepCount: 10,
  installQuality: 'pass',
  summary: {
    repoCount: 5,
    totalDelta: 225,
    totalStars: 15000,
    topLanguage: 'TypeScript',
    avgGrowth: 0.1,
    riskCount: { high: 0, medium: 0, low: 5 },
    enrichedCount: 5,
  },
  mermaid: [],
  repos: [
    {
      rank: 1,
      owner: 'acme',
      name: 'agent-kit',
      fullName: 'acme/agent-kit',
      url: 'https://github.com/acme/agent-kit',
      description: 'A toolkit for building LLM agents.',
      language: 'TypeScript',
      stars: 5000,
      delta: 100,
      topics: ['llm', 'agent'],
      readmeSnippet: 'README text that must never be sent to the model.',
    },
    {
      rank: 2,
      owner: 'acme',
      name: 'rag-cli',
      fullName: 'acme/rag-cli',
      url: 'https://github.com/acme/rag-cli',
      description: 'A CLI for retrieval augmented generation.',
      language: 'Python',
      stars: 3000,
      delta: 80,
      topics: ['rag', 'cli'],
      readmeSnippet: 'README text that must never be sent to the model.',
    },
    {
      rank: 3,
      owner: 'acme',
      name: 'tiny-utils',
      fullName: 'acme/tiny-utils',
      url: 'https://github.com/acme/tiny-utils',
      description: 'Tiny unrelated helpers.',
      language: 'JavaScript',
      stars: 2500,
      delta: 5,
      topics: ['utils'],
      readmeSnippet: '',
    },
    {
      rank: 4,
      owner: 'acme',
      name: 'site-builder',
      fullName: 'acme/site-builder',
      url: 'https://github.com/acme/site-builder',
      description: 'A static site generator.',
      language: 'Go',
      stars: 2000,
      delta: 10,
      topics: ['static-site'],
      readmeSnippet: '',
    },
    {
      rank: 5,
      owner: 'acme',
      name: 'ghost',
      fullName: 'acme/ghost',
      url: 'https://github.com/acme/ghost',
      description: 'A content management platform.',
      language: 'JavaScript',
      stars: 2500,
      delta: 30,
      topics: ['cms'],
      readmeSnippet: '',
    },
  ],
}

// Keep the module-level tests hermetic: no ambient key and no user key file.
const ENV_KEYS = ['DSH_GITHUB_TRENDING_AI_KEY', 'DEEPSEEK_API_KEY', 'DSH_GITHUB_TRENDING_AI_KEY_FILE']
const savedEnv = {}
for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
delete process.env.DSH_GITHUB_TRENDING_AI_KEY
delete process.env.DEEPSEEK_API_KEY
process.env.DSH_GITHUB_TRENDING_AI_KEY_FILE = missingKeyFile

try {
  // --- module: aiStatus -----------------------------------------------------
  await test('aiStatus: no key → configured false, host from baseUrl, no key in the view', () => {
    const bare = aiStatus({})
    assert.equal(bare.configured, false)
    assert.equal(bare.host, 'api.deepseek.com')
    assert.ok(!('key' in bare), 'status must not carry a key field')

    const configured = aiStatus({ baseUrl: 'https://ai.example.test:8443/v1/', model: 'demo-model', key: 'unit-key' })
    assert.equal(configured.configured, true)
    assert.equal(configured.host, 'ai.example.test:8443')
    assert.equal(configured.model, 'demo-model')
    assert.ok(!JSON.stringify(configured).includes('unit-key'), 'status must never echo the key')
  })

  await test('scoreRepos: no key throws AiNotConfiguredError before touching fetch', async () => {
    let calls = 0
    await assert.rejects(
      () =>
        scoreRepos({
          prompt: 'find agents',
          repos: [{ fullName: 'acme/agent-kit', name: 'agent-kit', description: '', topics: [] }],
          config: { baseUrl: 'http://127.0.0.1:1', model: 'demo-model', key: '' },
          fetchImpl: async () => {
            calls += 1
            throw new Error('must not be called')
          },
        }),
      (error) => error instanceof AiNotConfiguredError && error.name === 'AiNotConfiguredError',
    )
    assert.equal(calls, 0, 'no key must not produce a network attempt')
  })

  // --- module: scoreRepos ---------------------------------------------------
  const fakeAi = await startFakeServer(function ({ body, res }) {
    if (promptOf(body).includes('no-match')) {
      jsonResponse(res, chatPayload([]))
      return
    }
    jsonResponse(res, scoreFixture)
  })

  await test('scoreRepos: one batch, scores clamped to 0–100, reason cut to 60, unknown names dropped', async () => {
    const repos = REPO_FIXTURE.repos.map((repo) => ({
      fullName: repo.fullName,
      name: repo.name,
      description: repo.description,
      topics: repo.topics,
    }))
    const scores = await scoreRepos({
      prompt: '找几个 LLM 智能体工具',
      repos,
      config: { baseUrl: fakeAi.url, model: 'fixture-model', key: 'unit-key' },
      fetchImpl: fetch,
    })
    assert.equal(fakeAi.requests.length, 1, 'one batch request for five repositories')
    assert.deepEqual(
      Object.keys(scores).sort(),
      ['acme/agent-kit', 'acme/ghost', 'acme/rag-cli', 'acme/site-builder', 'acme/tiny-utils'],
      'five known repositories scored, unknown row dropped',
    )
    assert.equal(scores['acme/agent-kit'].score, 78)
    assert.equal(scores['acme/rag-cli'].score, 100, '130 is clamped to 100')
    assert.equal(scores['acme/tiny-utils'].score, 0, '-5 is clamped to 0')
    assert.equal(scores['acme/site-builder'].score, 56, '55.6 rounds to 56')
    assert.equal(scores['acme/ghost'].score, 100, '300 is clamped to 100')
    assert.equal(Array.from(scores['acme/rag-cli'].reason).length, MAX_REASON_CHARS, 'reason is cut to 60 chars')
    assert.ok(!('ghost/not-in-report' in scores), 'names not in the input are dropped')
  })

  await test('scoreRepos: request body carries only prompt + fullName/name/description/topics', async () => {
    const request = fakeAi.requests[0]
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/chat/completions')
    assert.equal(request.headers.authorization, 'Bearer unit-key')
    assert.equal(request.body.model, 'fixture-model')
    assert.equal(request.body.messages[0].role, 'system')
    assert.equal(request.body.messages[0].content, SCORE_SYSTEM_PROMPT)
    for (const needle of ['0–100', '60 字', '只输出 JSON']) {
      assert.ok(SCORE_SYSTEM_PROMPT.includes(needle), `system prompt must contain ${needle}`)
    }
    const user = JSON.parse(request.body.messages[1].content)
    assert.equal(user.prompt, '找几个 LLM 智能体工具')
    assert.equal(user.items.length, 5)
    for (const item of user.items) {
      assert.deepEqual(Object.keys(item).sort(), ['description', 'fullName', 'name', 'topics'])
    }
    assert.ok(!request.raw.includes('readmeSnippet'), 'README excerpt must not be sent')
    assert.ok(!request.raw.includes('unit-key'), 'key must not appear in the request body')
    assert.ok(!request.raw.includes('DSH-Workspace'), 'local path must not appear in the request body')
  })

  await test('scoreRepos: HTTP 500, transport error and timeout all degrade to {}', async () => {
    const failing = await startFakeServer(function ({ res }) {
      jsonResponse(res, { error: 'boom' }, 500)
    })
    const slow = await startFakeServer(function ({ res }) {
      setTimeout(function () {
        try {
          jsonResponse(res, chatPayload([{ fullName: 'acme/agent-kit', score: 90, reason: 'late' }]))
        } catch {
          /* client already aborted */
        }
      }, 400)
    })
    try {
      const repo = [{ fullName: 'acme/agent-kit', name: 'agent-kit', description: '', topics: [] }]
      const http500 = await scoreRepos({
        prompt: 'x',
        repos: repo,
        config: { baseUrl: failing.url, model: 'demo-model', key: 'unit-key' },
        fetchImpl: fetch,
      })
      assert.deepEqual(http500, {}, 'HTTP 500 degrades to {}')

      const transport = await scoreRepos({
        prompt: 'x',
        repos: repo,
        config: { baseUrl: failing.url, model: 'demo-model', key: 'unit-key' },
        fetchImpl: async () => {
          throw new Error('network down')
        },
      })
      assert.deepEqual(transport, {}, 'transport error degrades to {}')

      const started = Date.now()
      const timeout = await scoreRepos({
        prompt: 'x',
        repos: repo,
        config: { baseUrl: slow.url, model: 'demo-model', key: 'unit-key', timeoutMs: 60 },
        fetchImpl: fetch,
      })
      assert.deepEqual(timeout, {}, 'timeout degrades to {}')
      assert.ok(Date.now() - started < 350, 'timeout aborts early instead of waiting for the slow server')
      assert.equal(AI_TIMEOUT_MS, 25000)
    } finally {
      await failing.close()
      await slow.close()
    }
  })

  // --- module: sortByWeights ------------------------------------------------
  await test('sortByWeights: 0.6*score + 0.4*(delta/maxDelta*100), score alone when maxDelta is 0', () => {
    const conflict = [
      { fullName: 'high-match/low-growth', matchScore: 80, delta: 10 },
      { fullName: 'low-match/high-growth', matchScore: 40, delta: 100 },
    ]
    const ordered = sortByWeights(conflict, { match: 0.6, growth: 0.4 })
    assert.deepEqual(
      ordered.map((repo) => repo.fullName),
      ['low-match/high-growth', 'high-match/low-growth'],
      'growth can outrank a higher match score under 0.6/0.4',
    )

    const noGrowth = [
      { fullName: 'low', matchScore: 10, delta: 0 },
      { fullName: 'high', matchScore: 90, delta: 0 },
    ]
    assert.deepEqual(
      sortByWeights(noGrowth, { match: 0.6, growth: 0.4 }).map((repo) => repo.fullName),
      ['high', 'low'],
      'with maxDelta 0 the list falls back to match score',
    )
  })

  // --- module: searchRepos --------------------------------------------------
  const fakeSearch = await startFakeServer(function ({ res }) {
    jsonResponse(res, searchFixture)
  })

  await test('searchRepos: Search URL, Authorization, mapping and origin:search', async () => {
    const repos = await searchRepos({
      query: 'dsh agent panel',
      limit: 2,
      token: 'ghp-search-token',
      fetchImpl: async (url, init) => {
        const target = new URL(String(url))
        return fetch(fakeSearch.url + target.pathname + target.search, init)
      },
    })
    const request = fakeSearch.requests[0]
    assert.equal(request.method, 'GET')
    assert.match(request.url, /^\/search\/repositories\?/)
    assert.ok(request.url.includes('q=dsh+agent+panel'), `q is encoded: ${request.url}`)
    assert.ok(request.url.includes('sort=stars'))
    assert.ok(request.url.includes('order=desc'))
    assert.ok(request.url.includes('per_page=2'))
    assert.equal(request.headers.authorization, 'Bearer ghp-search-token')
    assert.ok(!request.url.includes('ghp-search-token'), 'token must not leak into the URL')
    assert.equal(repos.length, 2)
    assert.deepEqual(repos[0], {
      fullName: 'search/dsh-agent-panel',
      name: 'dsh-agent-panel',
      owner: 'search',
      url: 'https://github.com/search/dsh-agent-panel',
      description: 'A DSH panel plugin for agent workflows.',
      stars: 321,
      language: 'TypeScript',
      origin: 'search',
    })
    assert.equal(searchUrl('x', 0).includes('per_page=1'), true, 'limit is clamped to 1..50')
    assert.ok(searchUrl('x', 99).includes('per_page=50'))
    assert.ok(searchUrl('x', 5).startsWith(`${SEARCH_ENDPOINT}?`))
  })

  await test('searchRepos: non-200, malformed JSON and transport errors return []', async () => {
    const failing = await startFakeServer(function ({ res }) {
      res.statusCode = 403
      res.end('rate limited')
    })
    const malformed = await startFakeServer(function ({ res }) {
      res.statusCode = 200
      res.end('not json')
    })
    try {
      // Point the fetchImpl at each fake server explicitly; no real host is resolved.
      const againstFailing = await searchRepos({
        query: 'x',
        fetchImpl: async () => fetch(failing.url + '/search/repositories?q=x'),
      })
      assert.deepEqual(againstFailing, [], 'non-200 returns []')
      const againstMalformed = await searchRepos({
        query: 'x',
        fetchImpl: async () => fetch(malformed.url + '/search/repositories?q=x'),
      })
      assert.deepEqual(againstMalformed, [], 'malformed JSON returns []')
      assert.deepEqual(
        await searchRepos({
          query: 'x',
          fetchImpl: async () => {
            throw new Error('network down')
          },
        }),
        [],
        'transport error returns []',
      )
      assert.deepEqual(await searchRepos({ query: '' }), [], 'empty query returns []')
    } finally {
      await failing.close()
      await malformed.close()
    }
  })

  // --- route surface: 412 / 403 / 400 / scoring / fallback / 429 -----------
  const realFetch = globalThis.fetch
  const routeServer = http.createServer()
  const routes = new Map()
  routeServer.on('request', function (req, res) {
    let pathname = '/'
    try {
      pathname = new URL(String(req.url ?? '/'), 'http://127.0.0.1').pathname
    } catch {
      pathname = '/'
    }
    const route = routes.get(pathname)
    if (!route) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    Promise.resolve(route.handler(req, res)).catch(function () {
      if (!res.headersSent) {
        res.statusCode = 500
        res.end('route failed')
      }
    })
  })
  await new Promise(function (resolve, reject) {
    routeServer.once('error', reject)
    routeServer.listen(0, '127.0.0.1', resolve)
  })
  const routeAddress = routeServer.address()
  const routeOrigin = `http://127.0.0.1:${routeAddress.port}`

  const hostCtx = {
    get(name) {
      if (name === 'webServer') {
        return {
          register(route) {
            routes.set(route.path, route)
            return function () {
              routes.delete(route.path)
            }
          },
        }
      }
      return undefined
    },
    logger: { info() {}, warn() {} },
  }

  const { apply, rememberReportForTest, resetAiRateLimitForTest } = await import(
    pathToFileURL(path.resolve(rootDir, 'index.js')).href
  )

  /**
   * Tests must never reach a real host. Only api.github.com is rewritten (to the
   * loopback Search fake); every other host must be loopback or the call throws.
   */
  globalThis.fetch = function guardedFetch(input, init) {
    const rawUrl = typeof input === 'string' ? input : String(input && input.url ? input.url : '')
    let parsed
    try {
      parsed = new URL(rawUrl)
    } catch {
      return realFetch(input, init)
    }
    if (parsed.origin === new URL(SEARCH_ENDPOINT).origin) {
      return realFetch(fakeSearch.url + parsed.pathname + parsed.search, init)
    }
    const hostname = parsed.hostname.toLowerCase()
    if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') {
      return realFetch(input, init)
    }
    return Promise.reject(new Error(`test tried to reach external host ${parsed.host}`))
  }

  apply(hostCtx, {
    aiBaseURL: fakeAi.url,
    aiModel: 'fixture-model',
    searchThreshold: 5,
    searchFallback: true,
    token: 'ghp_route_token',
    sortWeights: { match: 0.6, growth: 0.4 },
  })
  rememberReportForTest(REPO_FIXTURE, 50)
  resetAiRateLimitForTest()

  async function postAi(body, origin) {
    const headers = { 'content-type': 'application/json', accept: 'application/json' }
    if (origin) headers.origin = origin
    const response = await fetch(routeOrigin + '/dsh-github-trending/ai', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }

  const baseBody = { prompt: '找几个 LLM 智能体工具', since: 'daily', language: '', limit: 50 }

  try {
    await test('route: no key → 412 and neither fake server is contacted', async () => {
      const beforeAi = fakeAi.requests.length
      const beforeSearch = fakeSearch.requests.length
      const result = await postAi(baseBody, routeOrigin)
      assert.equal(result.status, 412)
      assert.equal(result.body.configured, false)
      assert.equal(fakeAi.requests.length, beforeAi, 'no AI request without a key')
      assert.equal(fakeSearch.requests.length, beforeSearch, 'no Search request without a key')
    })

    process.env.DSH_GITHUB_TRENDING_AI_KEY = 'route-test-key'

    await test('route: cross-origin Origin → 403 before any model call', async () => {
      const beforeAi = fakeAi.requests.length
      const result = await postAi(baseBody, 'http://evil.example')
      assert.equal(result.status, 403)
      assert.equal(fakeAi.requests.length, beforeAi)
    })

    await test('route: 2001-character prompt → 400', async () => {
      const result = await postAi({ ...baseBody, prompt: 'x'.repeat(2001) }, routeOrigin)
      assert.equal(result.status, 400)
    })

    await test('route: five repositories scored, clamped, all trending items kept, request body clean', async () => {
      resetAiRateLimitForTest()
      const beforeAi = fakeAi.requests.length
      const beforeSearch = fakeSearch.requests.length
      const result = await postAi({ ...baseBody, prompt: '找几个 LLM 智能体工具' }, routeOrigin)
      assert.equal(result.status, 200)
      assert.equal(result.body.model, 'fixture-model')
      assert.equal(result.body.scored, 5)
      assert.ok(Number.isFinite(result.body.elapsedMs) && result.body.elapsedMs >= 0)
      assert.equal(fakeAi.requests.length, beforeAi + 1, 'one model request')

      const trending = result.body.items.filter((item) => item.origin === 'trending')
      assert.equal(trending.length, 5, 'all five trending repositories are kept')
      assert.deepEqual(
        trending.map((item) => item.fullName),
        ['acme/rag-cli', 'acme/agent-kit', 'acme/ghost', 'acme/site-builder', 'acme/tiny-utils'],
        '0.6*score + 0.4*(delta/maxDelta*100) order',
      )
      const byName = new Map(trending.map((item) => [item.fullName, item]))
      assert.equal(byName.get('acme/agent-kit').matchScore, 78)
      assert.equal(byName.get('acme/rag-cli').matchScore, 100)
      assert.equal(byName.get('acme/tiny-utils').matchScore, 0)
      assert.equal(byName.get('acme/site-builder').matchScore, 56)
      assert.equal(byName.get('acme/ghost').matchScore, 100)
      assert.equal(Array.from(byName.get('acme/rag-cli').matchReason).length, MAX_REASON_CHARS)
      assert.ok(byName.get('acme/agent-kit').matchReason.includes('智能体'))

      // Fallback also ran here (4 hits < 5) and its items sit at the end.
      assert.equal(result.body.search.used, true)
      assert.equal(result.body.search.count, 2)
      assert.ok(fakeSearch.requests.length > beforeSearch, 'Search fake was used')
      const searched = result.body.items.slice(-2)
      assert.deepEqual(searched.map((item) => item.origin), ['search', 'search'])
      assert.deepEqual(searched.map((item) => item.fullName), ['search/dsh-agent-panel', 'search/llm-filter-kit'])

      const request = fakeAi.requests[beforeAi]
      assert.equal(request.headers.authorization, 'Bearer route-test-key')
      assert.equal(request.body.model, 'fixture-model')
      assert.equal(request.body.messages[0].content, SCORE_SYSTEM_PROMPT)
      const raw = request.raw
      assert.ok(!raw.includes('route-test-key'), 'request body must not contain the key')
      assert.ok(!raw.includes('ghp_route_token'), 'request body must not contain the GitHub token')
      assert.ok(!raw.includes('DSH-Workspace') && !raw.includes('C:\\\\'), 'request body must not contain a local path')
      assert.ok(!raw.includes('readmeSnippet'), 'request body must not contain README text')
      const user = JSON.parse(request.body.messages[1].content)
      assert.equal(user.items.length, 5)
      for (const item of user.items) {
        assert.deepEqual(Object.keys(item).sort(), ['description', 'fullName', 'name', 'topics'])
      }
    })

    await test('route: zero hits → Search fallback returns two origin:search items at the end', async () => {
      resetAiRateLimitForTest()
      const beforeSearch = fakeSearch.requests.length
      const result = await postAi({ ...baseBody, prompt: 'no-match-please' }, routeOrigin)
      assert.equal(result.status, 200)
      assert.equal(result.body.scored, 0)
      assert.equal(result.body.search.used, true)
      assert.equal(result.body.search.count, 2)
      assert.equal(fakeSearch.requests.length, beforeSearch + 1, 'one Search request')
      const searchRequest = fakeSearch.requests[fakeSearch.requests.length - 1]
      assert.ok(searchRequest.url.includes('q=no-match-please'), `prompt is the query: ${searchRequest.url}`)
      assert.ok(searchRequest.url.includes('per_page=5'), 'fallback asks for five items')
      assert.equal(searchRequest.headers.authorization, 'Bearer ghp_route_token', 'Search uses the GitHub token')
      assert.ok(!searchRequest.url.includes('ghp_route_token'), 'token never appears in the Search URL')

      assert.equal(result.body.items.length, 7)
      assert.deepEqual(
        result.body.items.slice(-2).map((item) => item.origin),
        ['search', 'search'],
        'search items are appended after every trending item',
      )
      assert.equal(result.body.items.filter((item) => item.origin === 'trending').length, 5)
    })

    await test('route: the 11th call from one IP in a 60s window → 429 with retryAfter', async () => {
      resetAiRateLimitForTest()
      const statuses = []
      for (let index = 0; index < 10; index += 1) {
        const result = await postAi({ ...baseBody, prompt: `rate check ${index}` }, routeOrigin)
        statuses.push(result.status)
      }
      assert.deepEqual(statuses, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(() => 200))
      const limited = await postAi({ ...baseBody, prompt: 'rate check 11' }, routeOrigin)
      assert.equal(limited.status, 429)
      assert.ok(Number.isInteger(limited.body.retryAfter) && limited.body.retryAfter >= 1 && limited.body.retryAfter <= 60)
    })

    await test('route: /ai/info and /status expose host/model/weights without the key', async () => {
      const infoResponse = await fetch(routeOrigin + '/dsh-github-trending/ai/info')
      assert.equal(infoResponse.status, 200)
      const info = await infoResponse.json()
      assert.equal(info.configured, true)
      assert.equal(info.aiConfigured, true)
      assert.equal(info.host, new URL(fakeAi.url).host)
      assert.equal(info.model, 'fixture-model')
      assert.equal(info.searchThreshold, 5)
      assert.deepEqual(info.sortWeights, { match: 0.6, growth: 0.4 })
      assert.ok(!JSON.stringify(info).includes('route-test-key'))

      const statusResponse = await fetch(routeOrigin + '/dsh-github-trending/status')
      assert.equal(statusResponse.status, 200)
      const status = await statusResponse.json()
      assert.deepEqual(status, { configured: true, aiConfigured: true, model: 'fixture-model', githubTokenConfigured: true })
    })
  } finally {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined || savedEnv[key] === null) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    globalThis.fetch = realFetch
    assert.equal(globalThis.fetch, realFetch, 'globalThis.fetch must be restored to the original reference')
    await new Promise(function (resolve) {
      try {
        routeServer.closeAllConnections?.()
      } catch {
        /* older node */
      }
      routeServer.close(resolve)
    })
    await fakeAi.close()
    await fakeSearch.close()
  }
} finally {
  const failed = outcomes.filter((outcome) => !outcome.ok)
  console.log('')
  console.log(`${outcomes.length - failed.length}/${outcomes.length} tests passed`)
  if (failed.length > 0) process.exitCode = 1
}
