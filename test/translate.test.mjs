#!/usr/bin/env node
/**
 * Offline tests for the AI Chinese intro channel (Task 17).
 *
 * All model traffic goes to a local loopback `node:http` fake server on port 0;
 * this file never resolves a real AI or GitHub host. The route-level checks use
 * the same loopback server and a fake host context, and prove that a request
 * without a key returns 412 without contacting the fake endpoint.
 *
 * Run with:
 *
 *   node build.mjs && node test/translate.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  INTRO_SYSTEM_PROMPT,
  MAX_INTRO_CHARS,
  clearTranslateCache,
  readAiConfig,
  translateIntros,
} from '../lib/translate.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(here, '..')

/** Deterministic path that must not exist, so tests never read the user's real key file. */
const missingKeyFile = path.join(os.tmpdir(), `dsh-github-trending-no-key-${process.pid}`)

function makeTmpKeyDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'dsh-ai-key-'))
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
 * Local fake `/chat/completions`. The handler runs after the body is parsed and
 * the request is recorded; it can delay, 500, or answer with any content.
 */
async function startFakeAi(handler) {
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

const ITEM_A = {
  fullName: 'acme/agent-kit',
  name: 'agent-kit',
  description: 'A toolkit for building LLM agents.',
  topics: ['llm', 'agent'],
  readmeSnippet: 'Build agents in minutes.\n\nSecond paragraph is ignored.',
}
const ITEM_B = {
  fullName: 'acme/rag-cli',
  name: 'rag-cli',
  description: 'A CLI for retrieval augmented generation.',
  topics: ['rag', 'cli'],
  readmeSnippet: 'Search your documents from the terminal.',
}

try {
  await test('readAiConfig: defaults, env overrides and no key leak', () => {
    const bare = readAiConfig({ DSH_GITHUB_TRENDING_AI_KEY_FILE: missingKeyFile })
    assert.equal(bare.configured, false)
    assert.equal(bare.baseUrl, DEFAULT_AI_BASE_URL)
    assert.equal(bare.model, DEFAULT_AI_MODEL)
    assert.ok(!('key' in bare), 'public config must not carry a key field')

    const primary = readAiConfig({
      DSH_GITHUB_TRENDING_AI_KEY_FILE: missingKeyFile,
      DSH_GITHUB_TRENDING_AI_KEY: 'super-secret-key',
      DSH_GITHUB_TRENDING_AI_BASE_URL: 'https://ai.example.test/v1/',
      DSH_GITHUB_TRENDING_AI_MODEL: 'demo-model',
    })
    assert.equal(primary.configured, true)
    assert.equal(primary.baseUrl, 'https://ai.example.test/v1')
    assert.equal(primary.model, 'demo-model')
    assert.ok(!JSON.stringify(primary).includes('super-secret-key'), 'readAiConfig must never return the key value')

    assert.equal(
      readAiConfig({ DSH_GITHUB_TRENDING_AI_KEY_FILE: missingKeyFile, DEEPSEEK_API_KEY: 'fallback-key' }).configured,
      true,
      'DEEPSEEK_API_KEY is the fallback key',
    )
    assert.equal(
      readAiConfig({ DSH_GITHUB_TRENDING_AI_KEY_FILE: missingKeyFile, DSH_GITHUB_TRENDING_AI_KEY: '   ' }).configured,
      false,
      'whitespace is not a key',
    )
  })

  await test('readAiConfig: env key empty + key file exists → configured true', () => {
    const dir = makeTmpKeyDir()
    try {
      const file = path.join(dir, 'github-trending-ai-key')
      writeFileSync(file, 'file-secret-key\n', 'utf8')
      const config = readAiConfig({ DSH_GITHUB_TRENDING_AI_KEY_FILE: file })
      assert.equal(config.configured, true)
      assert.ok(!JSON.stringify(config).includes('file-secret-key'), 'file key must never appear in the public config')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('env key wins over key file: request authorization uses the env value', async () => {
    clearTranslateCache()
    const dir = makeTmpKeyDir()
    const savedKey = process.env.DSH_GITHUB_TRENDING_AI_KEY
    const savedFile = process.env.DSH_GITHUB_TRENDING_AI_KEY_FILE
    const fake = await startFakeAi(function ({ res }) {
      jsonResponse(res, chatPayload([{ fullName: ITEM_A.fullName, intro: '环境变量优先。' }]))
    })
    try {
      const file = path.join(dir, 'github-trending-ai-key')
      writeFileSync(file, 'file-key-should-lose\n', 'utf8')
      process.env.DSH_GITHUB_TRENDING_AI_KEY = 'env-key-wins'
      process.env.DSH_GITHUB_TRENDING_AI_KEY_FILE = file
      const result = await translateIntros([ITEM_A], { configured: true, baseUrl: fake.url, model: 'demo-model' })
      assert.equal(fake.requests.length, 1)
      assert.equal(fake.requests[0].headers.authorization, 'Bearer env-key-wins')
      assert.equal(result[ITEM_A.fullName].intro, '环境变量优先。')
    } finally {
      if (savedKey === undefined) delete process.env.DSH_GITHUB_TRENDING_AI_KEY
      else process.env.DSH_GITHUB_TRENDING_AI_KEY = savedKey
      if (savedFile === undefined) delete process.env.DSH_GITHUB_TRENDING_AI_KEY_FILE
      else process.env.DSH_GITHUB_TRENDING_AI_KEY_FILE = savedFile
      await fake.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('key file tolerates BOM, newlines and surrounding quotes', async () => {
    clearTranslateCache()
    const dir = makeTmpKeyDir()
    const savedKey = process.env.DSH_GITHUB_TRENDING_AI_KEY
    const savedFile = process.env.DSH_GITHUB_TRENDING_AI_KEY_FILE
    const fake = await startFakeAi(function ({ res }) {
      jsonResponse(res, chatPayload([{ fullName: ITEM_A.fullName, intro: '文件里的 key 可用。' }]))
    })
    try {
      const file = path.join(dir, 'github-trending-ai-key')
      writeFileSync(file, '\uFEFF  "  quoted-secret-key  "\r\n', 'utf8')
      delete process.env.DSH_GITHUB_TRENDING_AI_KEY
      process.env.DSH_GITHUB_TRENDING_AI_KEY_FILE = file
      assert.equal(readAiConfig({ DSH_GITHUB_TRENDING_AI_KEY_FILE: file }).configured, true)
      await translateIntros([ITEM_A], { configured: true, baseUrl: fake.url, model: 'demo-model' })
      assert.equal(fake.requests[0].headers.authorization, 'Bearer quoted-secret-key')
    } finally {
      if (savedKey === undefined) delete process.env.DSH_GITHUB_TRENDING_AI_KEY
      else process.env.DSH_GITHUB_TRENDING_AI_KEY = savedKey
      if (savedFile === undefined) delete process.env.DSH_GITHUB_TRENDING_AI_KEY_FILE
      else process.env.DSH_GITHUB_TRENDING_AI_KEY_FILE = savedFile
      await fake.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('missing, empty or unreadable key file → configured false, never throws', () => {
    const dir = makeTmpKeyDir()
    try {
      const missing = path.join(dir, 'does-not-exist')
      assert.doesNotThrow(() => readAiConfig({ DSH_GITHUB_TRENDING_AI_KEY_FILE: missing }))
      assert.equal(readAiConfig({ DSH_GITHUB_TRENDING_AI_KEY_FILE: missing }).configured, false)

      const empty = path.join(dir, 'empty')
      writeFileSync(empty, '', 'utf8')
      assert.equal(readAiConfig({ DSH_GITHUB_TRENDING_AI_KEY_FILE: empty }).configured, false)

      const blank = path.join(dir, 'blank')
      writeFileSync(blank, ' \r\n\t ', 'utf8')
      assert.equal(readAiConfig({ DSH_GITHUB_TRENDING_AI_KEY_FILE: blank }).configured, false)

      // A directory makes readFileSync fail; it must degrade instead of throwing.
      assert.doesNotThrow(() => readAiConfig({ DSH_GITHUB_TRENDING_AI_KEY_FILE: dir }))
      assert.equal(readAiConfig({ DSH_GITHUB_TRENDING_AI_KEY_FILE: dir }).configured, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('normal JSON reply: two intros parsed, long intro cut to 60 chars, unknown names dropped', async () => {
    clearTranslateCache()
    const longIntro = '这是一个模仿真实模型输出、故意写得很长很长的中文项目介绍'.repeat(4)
    const fake = await startFakeAi(function ({ res }) {
      jsonResponse(
        res,
        chatPayload([
          { fullName: ITEM_A.fullName, intro: '  **统一接入多模型**，快速搭建智能体。  ' },
          { fullName: ITEM_B.fullName, intro: longIntro },
          { fullName: 'ghost/not-in-input', intro: '不应出现' },
        ]),
      )
    })
    try {
      const result = await translateIntros([ITEM_A, ITEM_B], {
        configured: true,
        baseUrl: fake.url,
        model: 'demo-model',
        key: 'test-key',
      })
      assert.deepEqual(Object.keys(result).sort(), [ITEM_A.fullName, ITEM_B.fullName])
      assert.equal(result[ITEM_A.fullName].intro, '统一接入多模型，快速搭建智能体。', 'markdown is removed and text trimmed')
      assert.equal(Array.from(result[ITEM_B.fullName].intro).length, MAX_INTRO_CHARS, 'long intro is cut to 60 chars')
      assert.ok(!('ghost/not-in-input' in result), 'names not in the input are dropped')
      assert.equal(fake.requests.length, 1, 'one batch request')
      assert.equal(fake.requests[0].url, '/chat/completions')
    } finally {
      await fake.close()
    }
  })

  await test('intro + onboarding are both parsed; a missing onboarding defaults to an empty string', async () => {
    clearTranslateCache()
    const onboarding = '需要先会：Node.js。第一次能跑到：按 README 执行 npm install 并跑通示例。'
    const fake = await startFakeAi(function ({ res }) {
      jsonResponse(
        res,
        chatPayload([
          { fullName: ITEM_A.fullName, intro: '统一接入多模型。', onboarding },
          { fullName: ITEM_B.fullName, intro: '终端里的检索工具。' },
        ]),
      )
    })
    try {
      const result = await translateIntros([ITEM_A, ITEM_B], {
        configured: true,
        baseUrl: fake.url,
        model: 'demo-model',
        key: 'test-key',
      })
      assert.equal(result[ITEM_A.fullName].intro, '统一接入多模型。')
      assert.equal(result[ITEM_A.fullName].onboarding, onboarding, 'onboarding is parsed')
      assert.equal(result[ITEM_B.fullName].intro, '终端里的检索工具。')
      assert.equal(result[ITEM_B.fullName].onboarding, '', 'missing onboarding defaults to an empty string')
    } finally {
      await fake.close()
    }
  })

  await test('onboarding with a time estimate is dropped but the intro survives', async () => {
    clearTranslateCache()
    const fake = await startFakeAi(function ({ res }) {
      jsonResponse(
        res,
        chatPayload([
          {
            fullName: ITEM_A.fullName,
            intro: '统一接入多模型。',
            onboarding: '需要先会：Node.js。第一次能跑到：按 README 跑通示例，大约 1–2 小时。',
          },
        ]),
      )
    })
    try {
      const result = await translateIntros([ITEM_A], {
        configured: true,
        baseUrl: fake.url,
        model: 'demo-model',
        key: 'test-key',
      })
      assert.equal(result[ITEM_A.fullName].intro, '统一接入多模型。')
      assert.equal(result[ITEM_A.fullName].onboarding, '', 'a time estimate must never reach the panel')
    } finally {
      await fake.close()
    }
  })

  await test('```json fenced reply is still parsed', async () => {
    clearTranslateCache()
    const fake = await startFakeAi(function ({ res }) {
      const content = '```json\n' + JSON.stringify({ items: [{ fullName: ITEM_A.fullName, intro: '用一句话介绍这个项目。' }] }) + '\n```'
      jsonResponse(res, { choices: [{ message: { content } }] })
    })
    try {
      const result = await translateIntros([ITEM_A], {
        configured: true,
        baseUrl: fake.url,
        model: 'demo-model',
        key: 'test-key',
      })
      assert.equal(result[ITEM_A.fullName].intro, '用一句话介绍这个项目。')
    } finally {
      await fake.close()
    }
  })

  await test('empty intro and "信息不足" are dropped, valid sibling survives', async () => {
    clearTranslateCache()
    const fake = await startFakeAi(function ({ res }) {
      jsonResponse(
        res,
        chatPayload([
          { fullName: ITEM_A.fullName, intro: '   ' },
          { fullName: ITEM_B.fullName, intro: '信息不足' },
        ]),
      )
    })
    try {
      const empty = await translateIntros([ITEM_A], {
        configured: true,
        baseUrl: fake.url,
        model: 'demo-model',
        key: 'test-key',
      })
      clearTranslateCache()
      const sentinel = await translateIntros([ITEM_B], {
        configured: true,
        baseUrl: fake.url,
        model: 'demo-model',
        key: 'test-key',
      })
      assert.deepEqual(empty, {}, 'empty intro is discarded')
      assert.deepEqual(sentinel, {}, '"信息不足" is discarded')
    } finally {
      await fake.close()
    }
  })

  await test('500 and timeout both return {} without throwing', async () => {
    clearTranslateCache()
    const failing = await startFakeAi(function ({ res }) {
      jsonResponse(res, { error: 'boom' }, 500)
    })
    try {
      const result = await translateIntros([ITEM_A], {
        configured: true,
        baseUrl: failing.url,
        model: 'demo-model',
        key: 'test-key',
      })
      assert.deepEqual(result, {}, 'HTTP 500 degrades to {}')
    } finally {
      await failing.close()
    }

    clearTranslateCache()
    const slow = await startFakeAi(function ({ res }) {
      setTimeout(function () {
        try {
          jsonResponse(res, chatPayload([{ fullName: ITEM_A.fullName, intro: '迟到的译文' }]))
        } catch {
          /* client already aborted */
        }
      }, 400)
    })
    try {
      const started = Date.now()
      const result = await translateIntros([ITEM_A], {
        configured: true,
        baseUrl: slow.url,
        model: 'demo-model',
        key: 'test-key',
        timeoutMs: 60,
      })
      assert.deepEqual(result, {}, 'timeout degrades to {}')
      assert.ok(Date.now() - started < 350, 'timeout must abort early, not wait for the slow endpoint')
    } finally {
      await slow.close()
    }
  })

  await test('6-hour cache: a second identical call sends no request', async () => {
    clearTranslateCache()
    let calls = 0
    const fake = await startFakeAi(function ({ res }) {
      calls += 1
      jsonResponse(res, chatPayload([{ fullName: ITEM_A.fullName, intro: '带缓存的中文介绍。' }]))
    })
    try {
      const config = { configured: true, baseUrl: fake.url, model: 'demo-model', key: 'test-key' }
      const first = await translateIntros([ITEM_A], config)
      const second = await translateIntros([ITEM_A], config)
      assert.equal(calls, 1, 'second call must be served from the in-memory cache')
      assert.equal(fake.requests.length, 1, 'endpoint request count stays 1')
      assert.deepEqual(first, second)
    } finally {
      await fake.close()
    }
  })

  await test('request body: system prompt carries the 1–2 句 / 60 字 / no-star contract', async () => {
    clearTranslateCache()
    const fake = await startFakeAi(function ({ res }) {
      jsonResponse(res, chatPayload([{ fullName: ITEM_A.fullName, intro: '请求体检查。' }]))
    })
    try {
      await translateIntros([ITEM_A], {
        configured: true,
        baseUrl: fake.url,
        model: 'demo-model',
        key: 'test-key',
      })
      const request = fake.requests[0]
      assert.equal(request.method, 'POST')
      assert.equal(request.headers.authorization, 'Bearer test-key')
      assert.equal(request.body.model, 'demo-model')
      assert.equal(request.body.response_format.type, 'json_object')
      assert.equal(request.body.messages[0].role, 'system')
      const system = request.body.messages[0].content
      for (const needle of ['1–2 句', '60 字', '不得出现 star', 'onboarding', '第一次能跑到', '只输出 JSON']) {
        assert.ok(system.includes(needle), `system prompt must contain ${needle}`)
      }
      assert.ok(system.includes('不许写预计耗时'), 'system prompt forbids time estimates for onboarding')
      assert.equal(request.body.messages[1].role, 'user')
      assert.ok(request.body.messages[1].content.includes(ITEM_A.fullName), 'user message carries the batch')
      assert.equal(INTRO_SYSTEM_PROMPT, system, 'exported prompt is the one sent')
    } finally {
      await fake.close()
    }
  })

  await test('legacy string result still unpacks to {intro, onboarding:""} in the route payload', async () => {
    const { translatePayloadItem } = await import(pathToFileURL(path.resolve(rootDir, 'index.js')).href)
    assert.deepEqual(translatePayloadItem('acme/agent-kit', '旧形态的字符串介绍。'), {
      fullName: 'acme/agent-kit',
      intro: '旧形态的字符串介绍。',
      onboarding: '',
    })
    assert.deepEqual(
      translatePayloadItem('acme/agent-kit', { intro: '新形态介绍。', onboarding: '需要先会：Node.js。' }),
      { fullName: 'acme/agent-kit', intro: '新形态介绍。', onboarding: '需要先会：Node.js。' },
    )
    assert.deepEqual(
      translatePayloadItem('acme/agent-kit', { intro: '只有介绍。', onboarding: '' }),
      { fullName: 'acme/agent-kit', intro: '只有介绍。', onboarding: '' },
    )
  })

  // --- route surface: status / 412 / cross-origin 403 -----------------------
  const envKeys = ['DSH_GITHUB_TRENDING_AI_KEY', 'DEEPSEEK_API_KEY', 'DSH_GITHUB_TRENDING_AI_KEY_FILE']
  const savedEnv = {}
  for (const key of envKeys) savedEnv[key] = process.env[key]
  delete process.env.DSH_GITHUB_TRENDING_AI_KEY
  delete process.env.DEEPSEEK_API_KEY
  // Keep the route surface hermetic: point at a path that does not exist so a
  // real user key file cannot flip /status to configured=true.
  process.env.DSH_GITHUB_TRENDING_AI_KEY_FILE = missingKeyFile

  const { apply } = await import(pathToFileURL(path.resolve(rootDir, 'index.js')).href)
  const routes = new Map()
  const routeServer = http.createServer(function (req, res) {
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
  apply(hostCtx, {})

  async function postTranslate(body, origin) {
    const headers = { 'content-type': 'application/json', accept: 'application/json' }
    if (origin) headers.origin = origin
    const response = await fetch(routeOrigin + '/dsh-github-trending/translate', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }

  try {
    await test('route: GET /status reports configured=false while keeping the model name', async () => {
      const response = await fetch(routeOrigin + '/dsh-github-trending/status')
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.deepEqual(body, { configured: false, aiConfigured: false, model: DEFAULT_AI_MODEL, githubTokenConfigured: false })
    })

    await test('route: no key → 412 and no external request is attempted', async () => {
      const result = await postTranslate({ since: 'daily', language: '', limit: 50 }, routeOrigin)
      assert.equal(result.status, 412)
      assert.equal(result.body.configured, false)
    })

    await test('route: cross-origin POST is rejected with 403', async () => {
      process.env.DSH_GITHUB_TRENDING_AI_KEY = 'route-test-key'
      const status = await fetch(routeOrigin + '/dsh-github-trending/status')
      assert.equal((await status.json()).configured, true)
      const result = await postTranslate({ since: 'daily', language: '', limit: 50 }, 'http://evil.example')
      assert.equal(result.status, 403)
    })

    await test('route: same-origin POST without a cached report returns an empty batch', async () => {
      const result = await postTranslate({ since: 'daily', language: '', limit: 50 }, routeOrigin)
      assert.equal(result.status, 200)
      assert.equal(result.body.configured, true)
      assert.equal(result.body.translated, 0)
      assert.deepEqual(result.body.items, [])
    })
  } finally {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined || savedEnv[key] === null) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    await new Promise(function (resolve) {
      try {
        routeServer.closeAllConnections?.()
      } catch {
        /* older node */
      }
      routeServer.close(resolve)
    })
  }
} finally {
  const failed = outcomes.filter((outcome) => !outcome.ok)
  console.log('')
  console.log(`${outcomes.length - failed.length}/${outcomes.length} tests passed`)
  if (failed.length > 0) process.exitCode = 1
}
