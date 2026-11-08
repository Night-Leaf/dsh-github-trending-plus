#!/usr/bin/env node
/**
 * Offline tests for the Task-4 client panel: chip row, search, shortfall text,
 * network/install-quality banners and the empty custom-board hint.
 *
 * The client is a `window.__ModuleLoader__.load({ id, factory })` bundle, not an
 * ES module, so this test stubs the loader, captures the factory, feeds it the
 * local React shim and mounts the panel to inspect the produced markup.
 *
 * Run with:
 *
 *   node build.mjs && node test/client-panel.test.mjs --fixtures test/fixtures/client
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { React, mount } from './react-shim.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(here, '..')

function argumentValue(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  return fallback
}

const fixtureDir = path.resolve(rootDir, argumentValue('--fixtures', 'test/fixtures/client'))
const report50 = JSON.parse(await readFile(path.join(fixtureDir, 'report-50.json'), 'utf8'))
const reportShortfall = JSON.parse(await readFile(path.join(fixtureDir, 'report-shortfall.json'), 'utf8'))

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

// Load the client bundle through the loader contract the DSH Web shell uses.
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

const offlineFetch = async () => {
  throw new Error('client-panel.test.mjs must not touch the network')
}
globalThis.fetch = offlineFetch

await import(pathToFileURL(path.resolve(rootDir, 'client.js')).href)
const mod = captured.module
const api = mod && mod.__test

const CATALOG_KEYS = report50.catalog.map((rule) => rule.key)
const searchPlaceholder = api ? api.buildChips(report50).length : 0

// --- localStorage / banner-dismiss helpers ---------------------------------
// The panel reads `dsh-github-trending:ui` on its first render and writes it on
// dismiss. Each scenario below loads a fresh `client.js` instance (query-string
// cache-buster) so the React shim's per-component hook store starts empty.
const clientUrl = pathToFileURL(path.resolve(rootDir, 'client.js')).href
const UI_KEY = 'dsh-github-trending:ui'

function makeStorage(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null
    },
    setItem(key, value) {
      map.set(key, String(value))
    },
    removeItem(key) {
      map.delete(key)
    },
  }
}

async function loadFreshClient(tag) {
  const nodes = []
  const captureReact = {
    ...React,
    createElement(type, props, ...children) {
      const node = React.createElement(type, props, ...children)
      nodes.push(node)
      return node
    },
  }
  const captured = {}
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        captured.definition = definition
        captured.module = definition.factory((id) => {
          if (id === 'react') return captureReact
          throw new Error(`unexpected require: ${id}`)
        })
      },
    },
  }
  await import(clientUrl + '?ui=' + encodeURIComponent(tag))
  assert.ok(captured.module, 'fresh client module must register through __ModuleLoader__')
  return { mod: captured.module, nodes }
}

async function mountWithPayload(mod, payload) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  })
  return mountPanel(mod)
}

/** Mount the registered main panel with a custom fetch implementation. */
async function mountWithFetch(mod, fetchImpl) {
  globalThis.fetch = fetchImpl
  return mountPanel(mod)
}

async function mountPanel(mod) {
  const slots = []
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
    get() {
      return undefined
    },
  }
  mod.apply(ctx)
  const panel = slots.find((entry) => entry.config && entry.config.name === 'main')
  assert.ok(panel, 'main panel registered')
  const BannerStatePage = function BannerStatePage(props) {
    return React.createElement(panel.component, props)
  }
  const element = React.createElement(BannerStatePage, {})
  return { html: await mount(element), element }
}

/** Click the latest captured node carrying `attribute=value` and return it. */
function clickNode(nodes, attribute, value) {
  const found = nodes
    .filter((node) => node && node.props && node.props[attribute] === value && typeof node.props.onClick === 'function')
    .pop()
  assert.ok(found, `clickable ${attribute}=${value} must render`)
  found.props.onClick()
  return found
}

/** Click the latest captured button whose label contains `text`. */
function clickButtonByText(nodes, text) {
  const found = nodes
    .filter((node) => node && node.type === 'button' && node.props && typeof node.props.onClick === 'function')
    .filter((node) => (node.children || []).map((child) => (typeof child === 'string' ? child : '')).join('').includes(text))
    .pop()
  assert.ok(found, `clickable button "${text}" must render`)
  found.props.onClick()
  return found
}

function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }
}

function statusResponse() {
  return jsonResponse({ configured: false, aiConfigured: false, githubTokenConfigured: false })
}

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Same 50 repos, but stripped like the enrich=0 snapshot tier. */
function snapshotReport(since) {
  const report = JSON.parse(JSON.stringify(report50))
  report.since = since
  report.enrichedCount = 0
  for (const repo of report.repos) {
    repo.deepDive = []
    repo.aiModels = []
    repo.readmeZh = false
  }
  return report
}

/** Same 50 repos, but the first deep card carries a unique marker. */
function fullReport(since, marker) {
  const report = JSON.parse(JSON.stringify(report50))
  report.since = since
  report.repos[0].deepDive = [{ label: '完整档', text: marker }]
  return report
}

/** Let promise callbacks and the shim's state updates settle. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 25))
}

try {
  await test('module registers through __ModuleLoader__ with the Task-4 __test surface', () => {
    assert.ok(captured.definition, 'window.__ModuleLoader__.load must be called')
    assert.equal(typeof captured.definition.id, 'string')
    assert.ok(mod, 'factory must return the module object')
    assert.equal(typeof mod.apply, 'function', 'existing apply must stay intact')
    for (const key of ['buildChips', 'filterRepos', 'emptyHint', 'shortfallText', 'networkBanner', 'installQualityBanner']) {
      assert.equal(typeof api[key], 'function', `__test.${key}`)
    }
    assert.equal(searchPlaceholder, 14, 'buildChips callable before tests')
  })

  await test('chip row is "all" + the fixed 13 catalogue = 14 by default', () => {
    const chips = api.buildChips(report50)
    assert.equal(chips.length, 14)
    assert.deepEqual(chips.map((chip) => chip.key), ['all'].concat(CATALOG_KEYS))
    assert.equal(chips[0].label, '全部')
    assert.equal(chips.length, CATALOG_KEYS.length + 1)
  })

  await test('one custom board adds exactly one chip, giving 15', () => {
    const chips = api.buildChips({ ...report50, customBoards: [{ key: 'ai-safety', label: 'AI 安全', keywords: ['safety'] }] })
    assert.equal(chips.length, 15)
    assert.deepEqual(chips[chips.length - 1], { key: 'ai-safety', label: 'AI 安全', custom: true })
  })

  await test('author name search hits the owner', () => {
    const hits = api.filterRepos(report50.repos, 'all', 'octo-labs', [])
    assert.equal(hits.length, 1)
    assert.equal(hits[0].fullName, 'octo-labs/llm-agent-kit')
  })

  await test('topics search hits a tagged repository', () => {
    const hits = api.filterRepos(report50.repos, 'all', 'llm', [])
    assert.ok(hits.some((repo) => repo.fullName === 'octo-labs/llm-agent-kit'))
  })

  await test('programming-language search hits repositories by language', () => {
    const hits = api.filterRepos(report50.repos, 'all', 'rust', [])
    assert.ok(hits.length >= 1, 'at least one Rust repository')
    assert.ok(hits.every((repo) => [repo.language, ...(repo.stack || [])].join(' ').toLowerCase().includes('rust')))
  })

  await test('a repository with two categories is filtered out under both chips', () => {
    for (const chip of ['ai', 'learning']) {
      const hits = api.filterRepos(report50.repos, chip, '', []).map((repo) => repo.fullName)
      assert.ok(hits.includes('octo-labs/llm-agent-kit'), `${chip} must keep the dual-label repo`)
    }
  })

  await test('an uncategorised repository appears under "all" only', () => {
    const all = api.filterRepos(report50.repos, 'all', '', []).map((repo) => repo.fullName)
    assert.ok(all.includes('quiet-owner/quiet-utils'))
    for (const chip of CATALOG_KEYS) {
      const hits = api.filterRepos(report50.repos, chip, '', []).map((repo) => repo.fullName)
      assert.ok(!hits.includes('quiet-owner/quiet-utils'), `uncategorised repo must not appear under ${chip}`)
    }
  })

  await test('custom boards filter on merged fullName/description/tldr/stack/topics text', () => {
    const board = { key: 'agents', label: 'Agents', keywords: ['llm-agent-kit'] }
    const hits = api.filterRepos(report50.repos, 'agents', '', [board])
    assert.equal(hits.length, 1)
    assert.equal(hits[0].fullName, 'octo-labs/llm-agent-kit')
  })

  await test('shortfall text uses repos.length and the raw shortfallReason', () => {
    assert.equal(reportShortfall.repos.length, 45)
    assert.equal(api.shortfallText(reportShortfall), '数据源不足，仅收录 45 个（no-more-boards）')
    assert.equal(api.shortfallText(report50), '', 'no shortfall text when shortfall is zero')
  })

  await test('network fallback and degraded install quality are separate banners', () => {
    assert.equal(api.networkBanner({ networkStatus: 'fallback' }), '本次走了回退后端')
    assert.equal(api.networkBanner({ networkStatus: 'fail' }), '网络请求失败')
    assert.equal(api.networkBanner({ networkStatus: 'direct' }), '')
    assert.equal(api.installQualityBanner({ installQuality: 'degraded' }), '安装质量为降级（探针未全过）')
    assert.equal(api.installQualityBanner({ installQuality: 'pass' }), '')
  })

  // Single mount covers the rendered assertions: tabs, 15 chips, shortfall,
  // both banners and the empty custom-board hint.
  const board = { key: 'ai-safety', label: 'AI 安全', keywords: ['no-such-keyword'] }
  const payload = {
    ...reportShortfall,
    customBoards: [board],
    networkStatus: 'fallback',
    lastVia: 'harness-web',
    installQuality: 'degraded',
  }
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  })

  await test('mounted panel renders tabs, 15 chips, shortfall, both banners and the empty hint', async () => {
    assert.ok(mod, 'client module must have registered')
    const slots = []
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
      get() {
        return undefined
      },
    }
    mod.apply(ctx)
    const panel = slots.find((entry) => entry.config && entry.config.name === 'main')
    assert.ok(panel, 'main panel registered')

    const html = await mount(React.createElement(panel.component, { initialCategory: 'ai-safety' }))

    for (const label of ['日榜', '周榜', '月榜']) {
      assert.ok(html.includes(label), `period tab ${label}`)
    }
    assert.equal((html.match(/class="gt-chip"/g) || []).length, 15, '15 chip buttons')
    assert.ok(html.includes('AI 安全'), 'custom board chip label')
    assert.ok(html.includes('数据源不足，仅收录 45 个（no-more-boards）'), 'shortfall text')
    assert.ok(html.includes('本次走了回退后端'), 'fallback banner')
    assert.ok(html.includes('安装质量为降级（探针未全过）'), 'degraded banner')
    assert.ok(html.includes('当前没有仓库命中，可放宽关键词'), 'empty custom board hint')
    for (const term of ['仓库名', '作者名', '简介', 'topics', '编程语言']) {
      assert.ok(html.includes(term), `search placeholder mentions ${term}`)
    }
  })

  // --- Task-15: per-banner "不再显示" + remembered UI state -----------------

  await test('UI state: with no stored memory both banners render and nothing is stored', async () => {
    const storage = makeStorage()
    globalThis.localStorage = storage
    const { mod, nodes } = await loadFreshClient('ui-default')
    const { html } = await mountWithPayload(mod, payload)

    assert.ok(html.includes('本次走了回退后端'), 'fallback banner is visible by default')
    assert.ok(html.includes('数据源不足，仅收录 45 个（no-more-boards）'), 'shortfall banner is visible by default')
    assert.ok(!html.includes('提示已隐藏'), 'no restore line while nothing is hidden')
    assert.equal(storage.getItem(UI_KEY), null, 'opening the panel must not write the key')
    const kinds = nodes
      .filter((node) => node && node.props && node.props['data-dismiss'])
      .map((node) => node.props['data-dismiss'])
    assert.deepEqual([...new Set(kinds)].sort(), ['fallback', 'shortfall'], 'each banner carries one dismiss button')
  })

  await test('UI state: dismissing the shortfall banner hides only it and writes the key', async () => {
    const storage = makeStorage()
    globalThis.localStorage = storage
    const { mod, nodes } = await loadFreshClient('ui-shortfall')
    const { html, element } = await mountWithPayload(mod, payload)
    assert.ok(html.includes('数据源不足，仅收录 45 个'))

    clickNode(nodes, 'data-dismiss', 'shortfall')
    const after = await mount(element)

    assert.ok(!after.includes('数据源不足，仅收录'), 'dismissed shortfall banner is gone immediately')
    assert.ok(after.includes('本次走了回退后端'), 'the other banner stays visible')
    assert.ok(after.includes('提示已隐藏 · 点此恢复'), 'restore line appears once something is hidden')
    assert.deepEqual(JSON.parse(storage.getItem(UI_KEY)), { shortfall: true }, 'only the clicked flag is stored')
  })

  await test('UI state: a later panel mount remembers a dismissed banner', async () => {
    globalThis.localStorage = makeStorage({ [UI_KEY]: '{"shortfall":true}' })
    const { mod } = await loadFreshClient('ui-reload')
    const { html } = await mountWithPayload(mod, payload)

    assert.ok(!html.includes('数据源不足，仅收录'), 'stored shortfall flag keeps the banner hidden on reopen')
    assert.ok(html.includes('本次走了回退后端'), 'fallback banner is unaffected')
    assert.ok(html.includes('提示已隐藏 · 点此恢复'), 'restore line shows for the remembered banner')
  })

  await test('UI state: dismissing both banners stores both flags and restore shows them again', async () => {
    const storage = makeStorage()
    globalThis.localStorage = storage
    const { mod, nodes } = await loadFreshClient('ui-restore')
    const { element } = await mountWithPayload(mod, payload)

    clickNode(nodes, 'data-dismiss', 'shortfall')
    await mount(element)
    clickNode(nodes, 'data-dismiss', 'fallback')
    const hidden = await mount(element)

    assert.ok(!hidden.includes('本次走了回退后端'), 'fallback banner hidden')
    assert.ok(!hidden.includes('数据源不足，仅收录'), 'shortfall banner hidden')
    assert.ok(hidden.includes('提示已隐藏 · 点此恢复'), 'restore line is below the pager')
    assert.deepEqual(JSON.parse(storage.getItem(UI_KEY)), { fallback: true, shortfall: true }, 'both flags stored')

    clickNode(nodes, 'data-action', 'restore')
    const restored = await mount(element)

    assert.ok(restored.includes('本次走了回退后端'), 'fallback banner is back')
    assert.ok(restored.includes('数据源不足，仅收录 45 个（no-more-boards）'), 'shortfall banner is back')
    assert.ok(!restored.includes('提示已隐藏'), 'restore line disappears in the default state')
    assert.equal(storage.getItem(UI_KEY), null, 'restore clears the stored key')
  })

  await test('UI state: a throwing localStorage still renders and keeps both banners visible', async () => {
    const boom = () => {
      throw new Error('storage denied')
    }
    globalThis.localStorage = { getItem: boom, setItem: boom, removeItem: boom }
    const { mod, nodes } = await loadFreshClient('ui-throws')
    const { html, element } = await mountWithPayload(mod, payload)

    assert.ok(html.includes('本次走了回退后端'), 'fallback banner renders when storage throws')
    assert.ok(html.includes('数据源不足，仅收录 45 个（no-more-boards）'), 'shortfall banner renders when storage throws')
    assert.ok(!html.includes('提示已隐藏'), 'a throwing storage means nothing is remembered')

    clickNode(nodes, 'data-dismiss', 'shortfall')
    const after = await mount(element)
    assert.ok(!after.includes('数据源不足，仅收录'), 'dismiss still works for this session without storage')
    assert.ok(after.includes('本次走了回退后端'), 'panel did not crash after dismiss')
  })

  // --- Task-23: loading / error / retry states ------------------------------

  const errorPayload = {
    ...report50,
    repos: [],
    shortfall: 50,
    shortfallReason: 'network-error',
    networkStatus: 'fail',
    lastVia: '',
    durationMs: 12400,
    error: {
      class: 'network',
      detail: '抓取 GitHub Trending 失败（已尝试 2 次，耗时 12400 ms）：no transport could load …',
      attempts: [
        { attempt: 1, ms: 6100, reasons: ['direct: skipped (dns resolves to loopback)', 'doh-ip: no candidate address answered'] },
        { attempt: 2, ms: 6200, reasons: ['direct: skipped (dns resolves to loopback)', 'doh-ip: no candidate address answered'] },
      ],
    },
  }

  await test('loading state shows the skeleton and the elapsed-seconds line', async () => {
    globalThis.localStorage = makeStorage()
    const { mod } = await loadFreshClient('loading-elapsed')
    // Never settles: the panel must stay in its loading state, not wait for IPC.
    const never = new Promise(() => {})
    const { html } = await mountWithFetch(mod, () => never)

    assert.ok(html.includes('gt-skeleton'), 'skeleton blocks render while loading')
    assert.ok(html.includes('已等待'), 'elapsed-seconds label is visible while loading')
    assert.ok(html.includes('正在抓取 GitHub Trending'), 'the original loading hint is kept')
  })

  await test('report payload with error renders the error state, retry button, tabs and chips', async () => {
    globalThis.localStorage = makeStorage()
    const { mod } = await loadFreshClient('error-state')
    const { html } = await mountWithFetch(mod, async () => ({
      ok: true,
      status: 200,
      json: async () => errorPayload,
      text: async () => JSON.stringify(errorPayload),
    }))

    assert.ok(html.includes('网络失败'), 'readable network-failure headline')
    assert.ok(html.includes('已尝试 2 次'), 'error subtitle says the fetch was tried twice')
    assert.ok(html.includes('共 12.4 秒'), 'error subtitle uses the actual elapsed time')
    assert.equal((html.match(/data-tried="2"/g) || []).length, 1, 'attempt count sits next to the retry button')
    assert.ok(html.includes('data-error-state="1"'), 'error state marker')
    assert.ok(html.includes('data-retry="1"'), 'retry button is rendered')
    assert.ok(!html.includes('class="gt-skeleton"'), 'error state replaces the skeleton')
    assert.ok(!html.includes('数据源不足，仅收录 0 个'), 'no duplicate shortfall banner in the error state')
    assert.ok(!html.includes('本次走了回退后端'), 'no duplicate network banner in the error state')
    for (const label of ['日榜', '周榜', '月榜']) {
      assert.ok(html.includes(label), `period tab ${label} stays in the error state`)
    }
    assert.equal((html.match(/class="gt-chip"/g) || []).length, 14, 'chip row stays in the error state')
  })

  await test('retry from the error state requests refresh=1 and enters loading at once', async () => {
    globalThis.localStorage = makeStorage()
    const { mod, nodes } = await loadFreshClient('error-retry')
    const urls = []
    let calls = 0
    const fetchImpl = async (url) => {
      urls.push(String(url))
      calls += 1
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => errorPayload,
          text: async () => JSON.stringify(errorPayload),
        }
      }
      // The retried request never settles: the panel must already show loading,
      // not leave the stale error card up while it waits.
      return new Promise(() => {})
    }
    const { element } = await mountWithFetch(mod, fetchImpl)
    const before = urls.length
    assert.ok(before >= 1, 'initial report request was issued')

    clickNode(nodes, 'data-retry', '1')
    const after = await mount(element)

    assert.ok(urls.length > before, 'retry issues a second request')
    assert.ok(urls[urls.length - 1].includes('refresh=1'), `retry URL carries refresh=1: ${urls[urls.length - 1]}`)
    assert.ok(after.includes('gt-skeleton'), 'retry immediately renders the loading skeleton')
    assert.ok(!after.includes('data-error-state="1"'), 'the stale error card is gone during the retry')
  })

  await test('errorHeadline maps network / source / canceled to readable copy', () => {
    assert.ok(api.errorHeadline({ class: 'network' }).includes('网络失败'))
    assert.ok(api.errorHeadline({ class: 'source' }).includes('数据源失败'))
    assert.ok(api.errorHeadline({ class: 'canceled' }).includes('已取消'))
  })

  // --- Task-2 (v3b): two-phase snapshot + enriched tier ----------------------

  await test('two-phase', async () => {
    globalThis.localStorage = makeStorage()
    const { mod } = await loadFreshClient('two-phase')
    const urls = []
    const snapshot = snapshotReport('daily')
    snapshot.repos[0].tldr = 'SNAPSHOT-ONLY'
    const full = fullReport('daily', 'FULL-TIER-MARK')

    const { html } = await mountWithFetch(mod, async (url) => {
      const text = String(url)
      if (!text.includes('/report?')) return statusResponse()
      urls.push(text)
      return jsonResponse(text.includes('enrich=0') ? snapshot : full)
    })

    assert.ok(urls.length >= 2, `both phases must be requested: ${urls.join(' | ')}`)
    assert.ok(urls[0].includes('enrich=0'), `first request is the snapshot: ${urls[0]}`)
    assert.ok(urls[1].includes('enrich=1'), `second request is the full tier: ${urls[1]}`)
    assert.equal(
      urls[0].includes('refresh=1'),
      urls[1].includes('refresh=1'),
      'both phases must agree on the refresh flag',
    )
    assert.ok(html.includes('FULL-TIER-MARK'), 'the full tier replaced the snapshot')
    assert.ok(!html.includes('SNAPSHOT-ONLY'), 'snapshot content is gone once the full tier lands')
    assert.ok(!html.includes('data-deep-state="pending"'), 'the pending line disappears after the full tier lands')
  })

  await test('refresh-keeps-deep', async () => {
    globalThis.localStorage = makeStorage()
    const { mod, nodes } = await loadFreshClient('refresh-keeps-deep')
    const urls = []
    const snapshot = snapshotReport('daily')
    snapshot.repos[0].tldr = 'SNAPSHOT-REFRESH'
    const full = fullReport('daily', 'DEEP-KEEP')
    const refreshed = fullReport('daily', 'DEEP-UPDATED')
    const secondFull = createDeferred()
    let fullCalls = 0

    const { element } = await mountWithFetch(mod, async (url) => {
      const text = String(url)
      if (!text.includes('/report?')) return statusResponse()
      urls.push(text)
      if (text.includes('enrich=0')) return jsonResponse(snapshot)
      fullCalls += 1
      if (fullCalls === 1) return jsonResponse(full)
      return secondFull.promise
    })

    const first = await mount(element)
    assert.ok(first.includes('DEEP-KEEP'), 'initial full tier rendered a deep marker')
    const before = urls.length

    clickButtonByText(nodes, '刷新')
    const during = await mount(element)

    assert.ok(urls.length > before, 'refresh issued report requests')
    assert.ok(urls[urls.length - 1].includes('enrich=1'), 'refresh is waiting on the full tier')
    assert.ok(urls.some((entry) => entry.includes('refresh=1')), 'refresh requests carry refresh=1')
    assert.ok(during.includes('DEEP-KEEP'), 'the displayed deep card survived the refresh snapshot')
    assert.ok(!during.includes('SNAPSHOT-REFRESH'), 'the refresh snapshot did not replace the shown data')
    assert.ok(during.includes('data-deep-state="pending"'), 'pending line shows while the full tier is in flight')

    secondFull.resolve(jsonResponse(refreshed))
    await settle()
    const after = await mount(element)

    assert.ok(after.includes('DEEP-UPDATED'), 'the refreshed full tier replaced the data')
    assert.ok(!after.includes('DEEP-KEEP'), 'the old deep content is gone')
    assert.ok(!after.includes('data-deep-state="pending"'), 'the pending line disappears after success')
  })

  await test('late-failure', async () => {
    globalThis.localStorage = makeStorage()
    const { mod } = await loadFreshClient('late-failure')
    const urls = []
    const snapshot = snapshotReport('daily')
    snapshot.repos[0].tldr = 'LATE-SNAPSHOT-KEPT'

    const { html } = await mountWithFetch(mod, async (url) => {
      const text = String(url)
      if (!text.includes('/report?')) return statusResponse()
      urls.push(text)
      if (text.includes('enrich=0')) return jsonResponse(snapshot)
      throw new Error('full tier exploded')
    })

    assert.deepEqual(
      urls.map((entry) => entry.includes('enrich=1')),
      [false, true],
      `snapshot then full: ${urls.join(' | ')}`,
    )
    assert.ok(html.includes('LATE-SNAPSHOT-KEPT'), 'the snapshot stays rendered')
    assert.equal((html.match(/class="gt-repo gt-repo-/g) || []).length, 6, 'the snapshot cards still render')
    assert.ok(!html.includes('data-error-state="1"'), 'no error card after a late failure')
    assert.ok(html.includes('未更新'), 'the not-updated line is shown')
    assert.ok(html.includes('data-deep-state="failed"'), 'the line marks the failed full tier')
  })

  await test('stale-response', async () => {
    globalThis.localStorage = makeStorage()
    const { mod, nodes } = await loadFreshClient('stale-response')
    const urls = []
    const daily = createDeferred()
    const weeklySnapshot = snapshotReport('weekly')
    weeklySnapshot.repos[0].tldr = 'WEEKLY-SNAP'
    const weeklyFull = fullReport('weekly', 'WEEKLY-DEEP')
    const dailySnapshot = snapshotReport('daily')
    dailySnapshot.repos[0].tldr = 'DAILY-OLD'

    const { element } = await mountWithFetch(mod, async (url) => {
      const text = String(url)
      if (!text.includes('/report?')) return statusResponse()
      urls.push(text)
      if (text.includes('since=daily')) {
        if (text.includes('enrich=0')) return daily.promise
        return jsonResponse(fullReport('daily', 'DAILY-DEEP'))
      }
      if (text.includes('enrich=0')) return jsonResponse(weeklySnapshot)
      return jsonResponse(weeklyFull)
    })

    assert.ok(
      urls.some((entry) => entry.includes('since=daily') && entry.includes('enrich=0')),
      'the daily snapshot request is pending',
    )

    clickButtonByText(nodes, '周榜')
    const weeklyHtml = await mount(element)
    assert.ok(weeklyHtml.includes('WEEKLY-DEEP'), 'the weekly full tier rendered')
    assert.ok(!weeklyHtml.includes('WEEKLY-SNAP'), 'the weekly snapshot was replaced')

    daily.resolve(jsonResponse(dailySnapshot))
    await settle()
    const finalHtml = await mount(element)

    assert.ok(finalHtml.includes('WEEKLY-DEEP'), 'weekly stays the selected board')
    assert.ok(!finalHtml.includes('DAILY-OLD'), 'the stale daily response was ignored')
  })
} finally {
  globalThis.fetch = undefined
  globalThis.localStorage = undefined

  const failed = outcomes.filter((outcome) => !outcome.ok)
  console.log('')
  console.log(`${outcomes.length - failed.length}/${outcomes.length} tests passed`)
  if (failed.length > 0) process.exitCode = 1
}
