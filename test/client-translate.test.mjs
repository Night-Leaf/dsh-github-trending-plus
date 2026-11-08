#!/usr/bin/env node
/**
 * Offline tests for the Task-17 client hand-off:
 *
 *   - the template 项目介绍 renders first, then becomes the model intro;
 *   - only the 项目介绍 block changes (other blocks and order stay put);
 *   - a 412 or `configured: false` leaves the template untouched;
 *   - the same parameter set is requested at most once (no duplicate POSTs).
 *
 * The client bundle is a `window.__ModuleLoader__.load({...})` factory, so this
 * test stubs the loader, feeds the local React shim and stubs `fetch`. It never
 * resolves a real host.
 *
 * Run with:
 *
 *   node build.mjs && node test/client-translate.test.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { React, mount } from './react-shim.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(here, '..')
const clientUrl = pathToFileURL(path.resolve(rootDir, 'client.js')).href

const report50 = JSON.parse(await readFile(path.resolve(rootDir, 'test/fixtures/client/report-50.json'), 'utf8'))

const TRANSLATED = '统一接入多个模型并快速搭建智能体的工具包。'
const TRANSLATED_ONBOARDING = '需要先会：TypeScript 与 Node.js。第一次能跑到：按 README 执行 npm install 并跑通示例。'
const TEMPLATE_A = '第一仓库的模板项目介绍。'
const TEMPLATE_B = '第二仓库的模板项目介绍。'
const TEMPLATE_ONBOARDING = '需要先会：TypeScript、Node.js。第一次能跑到：按 README 安装并跑通第一个示例。'
const TECH_TEXT = 'TypeScript / Node.js / 自研调度器'

function buildReport() {
  const data = JSON.parse(JSON.stringify(report50))
  data.repos[0].deepDive = [
    { label: '项目介绍', text: TEMPLATE_A },
    { label: '技术栈', text: TECH_TEXT },
    { label: '上手门槛', text: TEMPLATE_ONBOARDING },
  ]
  data.repos[1].deepDive = [{ label: '项目介绍', text: TEMPLATE_B }]
  return data
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }
}

/**
 * Install a fetch stub that serves the report feed, the status probe and the
 * translate endpoint. `translate` receives the recorded request and may return
 * a promise so a test can hold the response until the template is on screen.
 */
function makeFetchStub(report, translate) {
  const calls = []
  const fetchStub = async function (url, init) {
    const target = String(url)
    calls.push({ url: target, method: (init && init.method) || 'GET' })
    if (target.includes('/dsh-github-trending/report?')) return jsonResponse(report)
    if (target.endsWith('/dsh-github-trending/status')) return jsonResponse({ configured: true, model: 'demo-model' })
    if (target.endsWith('/dsh-github-trending/translate')) return translate(init)
    throw new Error('unexpected fetch: ' + target)
  }
  return { calls, fetch: fetchStub }
}

async function loadFreshClient(tag) {
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
  await import(clientUrl + '?translate=' + encodeURIComponent(tag))
  assert.ok(captured.module, 'fresh client module must register through __ModuleLoader__')
  return captured.module
}

function applyClient(mod) {
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
  return {
    element: React.createElement(function PanelHost(props) {
      return React.createElement(panel.component, props)
    }, {}),
  }
}

async function settle(ms = 30) {
  await new Promise((resolve) => setTimeout(resolve, ms))
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

try {
  globalThis.localStorage = undefined

  await test('template renders first, then only the 项目介绍 block becomes the translation', async () => {
    const report = buildReport()
    let releaseTranslate
    const gate = new Promise((resolve) => {
      releaseTranslate = resolve
    })
    let translateCalls = 0
    const stub = makeFetchStub(report, async () => {
      translateCalls += 1
      await gate
      return jsonResponse({
        configured: true,
        model: 'demo-model',
        translated: 1,
        ms: 5,
        items: [{ fullName: report.repos[0].fullName, intro: TRANSLATED }],
      })
    })
    globalThis.fetch = stub.fetch

    const { element } = applyClient(await loadFreshClient('happy'))
    const before = await mount(element, { passes: 6 })
    assert.ok(before.includes(TEMPLATE_A), 'template intro must be visible before the model answers')
    assert.ok(!before.includes(TRANSLATED), 'translation must not appear early')
    assert.ok(before.includes(TECH_TEXT), 'other blocks render from the template')
    assert.ok(stub.calls.some((call) => call.url.endsWith('/translate')), 'translate request was issued')

    releaseTranslate()
    await settle()
    const after = await mount(element)

    assert.ok(after.includes(TRANSLATED), 'translation replaces the intro text')
    assert.ok(!after.includes(TEMPLATE_A), 'the template intro text is gone')
    assert.ok(after.includes(TECH_TEXT), 'the 技术栈 block is untouched')
    assert.ok(after.includes(TEMPLATE_B), 'a repository without a translation keeps its template')
    assert.equal(translateCalls, 1, 'exactly one translate POST')

    // Repeated renders/mounts must not duplicate the request.
    await mount(element)
    await mount(element)
    assert.equal(
      stub.calls.filter((call) => call.url.endsWith('/translate')).length,
      1,
      'same parameter set is requested once',
    )
  })

  await test('translation with onboarding replaces both 项目介绍 and 上手门槛', async () => {
    const report = buildReport()
    const stub = makeFetchStub(report, async () =>
      jsonResponse({
        configured: true,
        model: 'demo-model',
        translated: 1,
        ms: 5,
        items: [
          {
            fullName: report.repos[0].fullName,
            intro: TRANSLATED,
            onboarding: TRANSLATED_ONBOARDING,
          },
        ],
      }),
    )
    globalThis.fetch = stub.fetch

    const { element } = applyClient(await loadFreshClient('onboarding'))
    await mount(element, { passes: 6 })
    await settle()
    const html = await mount(element)

    assert.ok(html.includes(TRANSLATED), 'model intro replaces 项目介绍')
    assert.ok(html.includes(TRANSLATED_ONBOARDING), 'model onboarding replaces 上手门槛')
    assert.ok(!html.includes(TEMPLATE_A), 'the template intro text is gone')
    assert.ok(!html.includes(TEMPLATE_ONBOARDING), 'the rule-based onboarding sentence is gone')
    assert.ok(html.includes(TECH_TEXT), 'the 技术栈 block is untouched')
  })

  await test('empty onboarding replaces only 项目介绍 and keeps the rule sentence', async () => {
    const report = buildReport()
    const stub = makeFetchStub(report, async () =>
      jsonResponse({
        configured: true,
        model: 'demo-model',
        translated: 1,
        ms: 5,
        items: [{ fullName: report.repos[0].fullName, intro: TRANSLATED, onboarding: '' }],
      }),
    )
    globalThis.fetch = stub.fetch

    const { element } = applyClient(await loadFreshClient('empty-onboarding'))
    await mount(element, { passes: 6 })
    await settle()
    const html = await mount(element)

    assert.ok(html.includes(TRANSLATED), 'model intro replaces 项目介绍')
    assert.ok(html.includes(TEMPLATE_ONBOARDING), 'empty onboarding keeps the rule-based 上手门槛 text')
    assert.ok(!html.includes(TEMPLATE_A), 'the template intro text is gone')
  })

  await test('412 response leaves the template text in place', async () => {
    const report = buildReport()
    const stub = makeFetchStub(report, async () => jsonResponse({ configured: false }, 412))
    globalThis.fetch = stub.fetch

    const { element } = applyClient(await loadFreshClient('412'))
    const html = await mount(element, { passes: 6 })

    assert.ok(html.includes(TEMPLATE_A), 'template intro stays on a 412')
    assert.ok(!html.includes(TRANSLATED), 'no translation is injected on a 412')
    assert.equal(stub.calls.filter((call) => call.url.endsWith('/translate')).length, 1)
  })

  await test('status configured:false never calls /translate', async () => {
    const report = buildReport()
    const calls = []
    globalThis.fetch = async function (url) {
      const target = String(url)
      calls.push(target)
      if (target.includes('/report?')) return jsonResponse(report)
      if (target.endsWith('/status')) return jsonResponse({ configured: false, model: 'demo-model' })
      throw new Error('translate must not be called when unconfigured: ' + target)
    }

    const { element } = applyClient(await loadFreshClient('unconfigured'))
    const html = await mount(element, { passes: 6 })

    assert.ok(html.includes(TEMPLATE_A), 'template intro stays when no key is configured')
    assert.ok(!calls.some((url) => url.endsWith('/translate')), 'no translate request without a key')
  })

  await test('snapshot tier waits for the full report before asking for a model intro', async () => {
    const full = buildReport()
    full.enrichedCount = 10
    const snapshot = JSON.parse(JSON.stringify(full))
    snapshot.enrichedCount = 0
    snapshot.repos = snapshot.repos.map((repo) => ({ ...repo, readmeSnippet: '', topics: [] }))

    let releaseFull
    const fullGate = new Promise((resolve) => {
      releaseFull = resolve
    })
    let translateCalls = 0
    globalThis.fetch = async function (url, init) {
      const target = String(url)
      if (target.includes('/report?')) {
        if (target.includes('enrich=0')) return jsonResponse(snapshot)
        await fullGate
        return jsonResponse(full)
      }
      if (target.endsWith('/status')) return jsonResponse({ configured: true, model: 'demo-model' })
      if (target.endsWith('/translate')) {
        translateCalls += 1
        return jsonResponse({
          configured: true,
          model: 'demo-model',
          translated: 1,
          ms: 5,
          items: [{ fullName: full.repos[0].fullName, intro: TRANSLATED }],
        })
      }
      throw new Error('unexpected fetch: ' + target)
    }

    const { element } = applyClient(await loadFreshClient('two-phase-translate'))
    const before = await mount(element, { passes: 6 })
    assert.ok(before.includes(TEMPLATE_A), 'the snapshot renders the template intro first')
    assert.equal(translateCalls, 0, 'no model intro is requested while only the snapshot is on screen')

    releaseFull()
    await settle(60)
    const after = await mount(element)

    assert.ok(translateCalls >= 1, 'the full report triggers the translate request')
    assert.ok(after.includes(TRANSLATED), 'the model intro replaces the template once the full tier lands')
  })
} finally {
  globalThis.fetch = undefined
  globalThis.localStorage = undefined

  const failed = outcomes.filter((outcome) => !outcome.ok)
  console.log('')
  console.log(`${outcomes.length - failed.length}/${outcomes.length} tests passed`)
  if (failed.length > 0) process.exitCode = 1
}
