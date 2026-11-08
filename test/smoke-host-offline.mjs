/**
 * Offline host smoke test: mounts the plugin against a fake Cordis context and
 * asserts the Phase 1 registration surface. No network is allowed: `fetch` is
 * replaced with a throwing stub before the host entry is imported, and the test
 * fails if anything tries to use it.
 *
 * Usage: node test/smoke-host-offline.mjs
 */

const networkAttempts = []
globalThis.fetch = (...args) => {
  networkAttempts.push(String(args[0] ?? ''))
  throw new Error('offline smoke test: network disabled')
}

// The 412 check below must be deterministic: an ambient key would turn it into
// a real (offline-throwing) request and hide the unconfigured path. The key
// file matters too: readAiConfig falls back to the user's default key file
// (%USERPROFILE%\.dsh\github-trending-ai-key) when this env var is unset, so
// point it at a path that never exists.
import os from 'node:os'
import path from 'node:path'

delete process.env.DSH_GITHUB_TRENDING_AI_KEY
delete process.env.DEEPSEEK_API_KEY
process.env.DSH_GITHUB_TRENDING_AI_KEY_FILE = path.join(os.tmpdir(), '__dsh_no_such_key_file__')

import { Readable } from 'node:stream'

const { apply } = await import('../index.js')
const { normalizeCustomBoards, reportQuery } = await import('../lib/report.js')
const { CATEGORY_CATALOG } = await import('../lib/categories.js')

const registered = { tools: [], commands: [], routes: [] }
const logs = []

const webServer = {
  register(route) {
    registered.routes.push(route)
    return () => {
      registered.routes = registered.routes.filter((item) => item !== route)
    }
  },
}

const ctx = {
  tools: {
    register(definition) {
      registered.tools.push(definition)
      return () => {
        registered.tools = registered.tools.filter((item) => item !== definition)
      }
    },
  },
  effect(setup) {
    setup()
  },
  inject(_deps, callback) {
    callback(ctx)
  },
  get(name) {
    if (name === 'commands') {
      return {
        register(definition) {
          registered.commands.push(definition)
          return () => {}
        },
      }
    }
    if (name === 'webServer') return webServer
    return undefined
  },
  logger: {
    info(message) {
      logs.push(message)
    },
    warn(message) {
      logs.push(message)
    },
  },
}

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

// [1/4] Mount with the default config: no token, no network, no timers needed.
apply(ctx, {})

assert(registered.tools.length === 1, `one tool registered, got ${registered.tools.length}`)
assert(registered.tools[0].name === 'github_trending', `tool name is ${registered.tools[0].name}`)
assert(typeof registered.tools[0].execute === 'function', 'tool execute present')
assert(registered.tools[0].output && typeof registered.tools[0].output.render === 'function', 'tool output.render present')
assert(registered.commands.length === 1, `one command registered, got ${registered.commands.length}`)
assert(registered.commands[0].name === 'github-trending', `command name is ${registered.commands[0].name}`)
console.log(`[1/4] mounted: ${registered.tools.length} tool, ${registered.commands.length} command, ${registered.routes.length} route(s)`)
console.log(`      logs: ${logs.join(' | ')}`)

// [2/4] Route surface: the JSON report feed plus Translate/Status and the Phase 2 AI pair.
assert(registered.routes.length === 5, `five routes registered, got ${registered.routes.length}`)
const routePaths = registered.routes.map((route) => route.path)
assert(
  JSON.stringify(routePaths) ===
    JSON.stringify([
      '/dsh-github-trending/report',
      '/dsh-github-trending/translate',
      '/dsh-github-trending/ai',
      '/dsh-github-trending/ai/info',
      '/dsh-github-trending/status',
    ]),
  `route paths are ${routePaths.join(', ')}`,
)
const byPath = new Map(registered.routes.map((route) => [route.path, route]))
for (const [routePath, method] of [
  ['/dsh-github-trending/report', 'GET'],
  ['/dsh-github-trending/translate', 'POST'],
  ['/dsh-github-trending/ai', 'POST'],
  ['/dsh-github-trending/ai/info', 'GET'],
  ['/dsh-github-trending/status', 'GET'],
]) {
  const route = byPath.get(routePath)
  assert(route && route.kind === 'exact', `${routePath} is an exact route`)
  assert(typeof route.handler === 'function', `${routePath} handler present`)
  assert(Array.isArray(route.methods) && route.methods.includes(method), `${routePath} declares ${method}`)
}
console.log(`[2/4] routes ok: ${routePaths.join(' | ')}`)

// [2b/4] Unconfigured /translate returns 412 without touching any endpoint.
function captureResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value
    },
    end(body) {
      this.body = body === undefined || body === null ? '' : String(body)
    },
  }
}

const translateRequest = Readable.from([Buffer.from(JSON.stringify({ since: 'daily', language: '', limit: 50 }))])
translateRequest.method = 'POST'
translateRequest.headers = { host: '127.0.0.1:3080' }
const translateResponse = captureResponse()
await byPath.get('/dsh-github-trending/translate').handler(translateRequest, translateResponse)
assert(translateResponse.statusCode === 412, `unconfigured translate returns 412, got ${translateResponse.statusCode}`)
assert(JSON.parse(translateResponse.body).configured === false, '412 body reports configured:false')
assert(networkAttempts.length === 0, `unconfigured translate made a network attempt: ${networkAttempts.join(', ')}`)
console.log('[2b/4] unconfigured translate: 412, 0 network attempts')

const statusResponse = captureResponse()
await byPath.get('/dsh-github-trending/status').handler({ method: 'GET', headers: {} }, statusResponse)
assert(statusResponse.statusCode === 200, `status returns 200, got ${statusResponse.statusCode}`)
assert(JSON.parse(statusResponse.body).configured === false, 'status reports configured:false without a key')

const wrongMethodResponse = captureResponse()
await byPath.get('/dsh-github-trending/status').handler({ method: 'POST', headers: {} }, wrongMethodResponse)
assert(wrongMethodResponse.statusCode === 405, `wrong method returns 405, got ${wrongMethodResponse.statusCode}`)
console.log('[2c/4] status + method guard ok')

// [3/4] Defaults that the panel depends on.
const query = reportQuery({})
assert(query.limit === 50, `reportQuery({}).limit is ${query.limit}, expected 50`)
assert(query.since === 'daily', `reportQuery({}).since is ${query.since}, expected daily`)
assert(CATEGORY_CATALOG.length >= 13, `CATEGORY_CATALOG.length is ${CATEGORY_CATALOG.length}, expected >= 13`)
assert(normalizeCustomBoards(undefined).length === 0, 'customBoards defaults to an empty array')
assert(normalizeCustomBoards([]).length === 0, 'customBoards accepts an empty array')
console.log(`[3/4] defaults ok: limit=${query.limit}, catalog=${CATEGORY_CATALOG.length}, customBoards=0`)

// [4/4] The test made no network request, directly or through the transport.
assert(networkAttempts.length === 0, `network was used: ${networkAttempts.join(', ')}`)
console.log('[4/4] offline ok: 0 network attempts')

console.log('ok')
