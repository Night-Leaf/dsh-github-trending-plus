#!/usr/bin/env node
/**
 * Client-side smoke test: loads client.js through a fake __ModuleLoader__,
 * mounts the panel component with a minimal React shim and asserts that the
 * rendered markup contains the report data. No browser required.
 *
 * Usage: node test/smoke-client.mjs [daily|weekly|monthly] [language]
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getReport } from '../lib/report.js'
import { React, mount } from './react-shim.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const since = process.argv[2] ?? 'daily'
const language = process.argv[3] ?? null

const slots = []
const locales = []
const captured = {}

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured.definition = definition
      captured.module = definition.factory((id) => {
        if (id === 'react') return React
        throw new Error(`unexpected require: ${id}`)
      })
    },
  },
}

console.log('smoke-client 需要真实网络，失败时按跳过处理')

let report
try {
  report = await getReport({ since, language, limit: 12, focus: 3, refresh: false })
} catch (error) {
  // GitHub may be unreachable from this machine while the running Harness still
  // holds a cached report, so ride the plugin's own HTTP route as a fallback.
  const query = new URLSearchParams({ since })
  if (language) query.set('language', language)
  const port = process.env.DSH_WEB_PORT || '54381'
  const url = `http://127.0.0.1:${port}/dsh-github-trending/report?${query}`
  console.warn(`live fetch failed (${error.message}); falling back to ${url}`)
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`report route HTTP ${response.status}`)
    report = await response.json()
  } catch (fallbackError) {
    // This is a smoke script, not an assertion test: without a real network
    // there is nothing meaningful to assert, so report the skip and exit 0.
    console.log(`skipped: network unavailable (${error.message}; fallback: ${fallbackError.message})`)
    process.exit(0)
  }
}

if (!report || !Array.isArray(report.repos) || report.repos.length === 0) {
  console.log('skipped: network unavailable (report has no repositories)')
  process.exit(0)
}

const payload = { ...report }
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => payload,
  text: async () => JSON.stringify(payload),
})

await import(pathToFileURL(resolve(root, 'client.js')).href)

const mod = captured.module
if (!mod) {
  console.error('client module did not register through __ModuleLoader__')
  process.exit(1)
}

const ctx = {
  slots: {
    inject(key, cb) {
      cb()
      return () => {}
    },
    register(config, component) {
      slots.push({ config, component })
      return () => {}
    },
  },
  get(name) {
    if (name === 'locale') {
      return {
        register(ns, dict) {
          locales.push({ ns, dict })
        },
        bind: () => (key) => key,
      }
    }
    return undefined
  },
}

mod.apply(ctx)

const failures = []
const check = (ok, label, detail = '') => {
  if (ok) console.log(`  ok   ${label}`)
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}

const navEntry = slots.find((entry) => entry.config?.name === 'sidebar.panellist')
const panel = slots.find((entry) => entry.config?.name === 'main')

check(Boolean(navEntry), 'sidebar.panellist registered')
check(navEntry?.config?.id === 'github-trending', 'sidebar entry id', String(navEntry?.config?.id))
check(Boolean(panel), 'main panel registered')
check(locales.length >= 2, 'locale dictionaries registered', String(locales.length))

if (!panel) {
  console.error('\nclient smoke failed: panel missing')
  process.exit(1)
}

const html = await mount(React.createElement(panel.component, {}))

const first = report.repos[0]
const visibleRepos = report.repos.slice(0, 6)
check(visibleRepos.every((repo) => html.includes(repo.fullName)), 'renders first page of repos')
check(Boolean(first) && html.includes(first.fullName), 'renders top repo', String(first?.fullName))
check(/刷新|Refresh/.test(html), 'renders refresh control')
check(!/导出 Markdown|Export Markdown|dsh-github-trending\/export/.test(html), 'panel has no export control')
check(!/正在抓取|Loading/.test(html), 'loading state replaced by data')
check(html.length > 8000, 'markup size', String(html.length))
check(!/undefined|NaN/.test(html), 'no undefined/NaN in markup')
// Cards use `gt-repo gt-repo-deep` / `gt-repo gt-repo-simple` since v2, so match
// the class prefix instead of the exact v1 class `gt-repo`.
const cardCount = (html.match(/class="gt-repo(?:\s|")/g) || []).length
const blockCount = (html.match(/class="gt-block"/g) || []).length
check(cardCount > 0, 'renders repo cards', String(cardCount))
check(blockCount === cardCount, 'analysis rendered inline per card', `${blockCount} blocks / ${cardCount} cards`)
check(!/查看分析|gt-card-more|gt-bar-row|Mermaid/.test(html), 'no fold-out toggle, bar chart or mermaid source')

mkdirSync(resolve(here, 'out'), { recursive: true })
writeFileSync(resolve(here, 'out', `panel-${since}${language ? `-${language}` : ''}.html`), html)

console.log('')
if (failures.length) {
  console.log(`client smoke failed: ${failures.length} check(s)`)
  process.exit(1)
}
console.log(`client smoke ok: ${report.repos.length} repos, ${html.length} chars of markup`)