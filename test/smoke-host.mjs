/**
 * Host smoke test: mounts the plugin against a fake Cordis context, then
 * exercises the real network path (tool execution + the JSON report route).
 *
 * Usage: node test/smoke-host.mjs [since] [language]
 */

import { apply } from '../index.js'

const registered = { tools: [], commands: [], routes: [] }
const logs = []

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
  get(name) {
    if (name === 'commands') {
      return {
        register(definition) {
          registered.commands.push(definition)
          return () => {}
        },
      }
    }
    if (name === 'webServer') {
      return {
        register(route) {
          registered.routes.push(route)
          return () => {
            registered.routes = registered.routes.filter((item) => item !== route)
          }
        },
      }
    }
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

function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[String(key).toLowerCase()] = value
    },
    end(chunk) {
      this.body = chunk === undefined ? '' : String(chunk)
    },
  }
}

const since = process.argv[2] || 'daily'
const language = process.argv[3] || ''

apply(ctx, { defaultLimit: 15, defaultFocus: 3 })

assert(registered.tools.length === 1, 'one tool registered')
assert(registered.tools[0].name === 'github_trending', `tool name is ${registered.tools[0].name}`)
assert(registered.commands.length === 1, 'one command registered')
assert(registered.commands[0].name === 'github-trending', 'command name has no slash')
assert(registered.routes.length === 1, 'one route registered')
assert(registered.routes[0].path === '/dsh-github-trending/report', 'route path')
assert(registered.tools[0].output && typeof registered.tools[0].output.render === 'function', 'tool output.render present')

console.log('[1/3] mounting ok:', logs.join(' | '))

const started = Date.now()
const tool = registered.tools[0]
const value = await tool.execute({ since, language, limit: 15, focus: 3 }, {})
assert(value.repoCount > 0, 'tool returned repositories')
assert(value.repos.length === value.repoCount, 'tool repo list matches count')
const text = tool.output.render({}, value)[0].text
assert(typeof text === 'string' && text.length > 100, 'rendered digest has content')
console.log(`[2/3] tool execute ok in ${Date.now() - started}ms (${value.repoCount} repos, +${value.totalDelta} stars)`)
console.log(text.split('\n').slice(0, 6).join('\n'))

const reportRoute = registered.routes.find((route) => route.path.endsWith('/report'))
const res = fakeResponse()
await reportRoute.handler({ url: `/dsh-github-trending/report?since=${since}&language=${language}&limit=15&focus=3` }, res)
assert(res.statusCode === 200, `report route status ${res.statusCode}: ${res.body.slice(0, 200)}`)
const payload = JSON.parse(res.body)
assert(Array.isArray(payload.repos) && payload.repos.length > 0, 'json payload has repos')
assert(payload.repos[0].deepDive.length > 0, 'json payload has deep dive blocks')
assert(payload.summary && payload.summary.languages.length > 0, 'json payload has language summary')
assert(!('markdown' in payload) && !('exportPath' in payload), 'json payload carries no markdown artefacts')
console.log(`[3/3] GET /report ok: ${payload.repos.length} repos, cache=${payload.cache}, mermaid=${payload.mermaid.length}`)

const cacheRes = fakeResponse()
await reportRoute.handler({ url: `/dsh-github-trending/report?since=${since}&language=${language}&limit=15&focus=3` }, cacheRes)
console.log('cache probe status:', cacheRes.statusCode, 'cache:', JSON.parse(cacheRes.body).cache)