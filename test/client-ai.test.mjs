#!/usr/bin/env node
/**
 * Offline tests for the Task-22 AI-filter panel.
 *
 * The client bundle is a `window.__ModuleLoader__.load({...})` factory, so this
 * test stubs the loader, feeds the local React shim, stubs `fetch` for every
 * panel route (/report, /status, /ai/info, /ai) and stubs `localStorage`. It
 * never resolves a real host.
 *
 * Covers:
 *   - aiConfigured:false => disabled entry, a synthetic click sends 0 requests;
 *   - configured entry expands a natural-language input;
 *   - first submit shows the privacy consent (host + payload), cancel = 0 /ai;
 *   - agree writes localStorage and sends exactly one POST carrying the prompt;
 *   - match score + reason render, search fallback is its own group, and the
 *     board keeps the API's order even when scores are the opposite;
 *   - 412 / 403 / 429 / timeout show one readable line and keep the board;
 *   - clear removes match badges + the search group;
 *   - the config tutorial is collapsed by default and shows the env/file route;
 *   - unusable storage means "ask every time" without crashing;
 *   - a missing /ai/info host falls back to the generic label.
 *
 * Run with:
 *
 *   node build.mjs && node test/client-ai.test.mjs
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

const CONSENT_KEY = 'dsh-github-trending:ai-consent'
const AI_URL = '/dsh-github-trending/ai'
const PROMPT = '给我找几个 dsh 的美观性插件'

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }
}

function makeStorage(seed = {}, events = []) {
  const map = new Map(Object.entries(seed))
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null
    },
    setItem(key, value) {
      map.set(key, String(value))
      if (key === CONSENT_KEY) events.push('consent-write')
    },
    removeItem(key) {
      map.delete(key)
    },
  }
}

/**
 * One fetch stub for the whole panel. `options.ai` receives the recorded /ai
 * call and may return any response (412/403/429/200) or throw to simulate an
 * aborted request.
 */
function makeFetchStub(options = {}) {
  const calls = []
  const events = []
  const configured = options.configured !== false
  const stub = async function (url, init) {
    const target = String(url)
    const method = (init && init.method) || 'GET'
    const call = { url: target, method, body: init && init.body }
    calls.push(call)
    if (target.includes('/dsh-github-trending/report?')) return jsonResponse(options.report || report50)
    if (target.endsWith('/dsh-github-trending/status')) {
      return jsonResponse({
        configured: configured,
        aiConfigured: configured,
        model: 'demo-model',
        githubTokenConfigured: options.githubTokenConfigured === true,
      })
    }
    if (target.endsWith('/dsh-github-trending/ai/info')) {
      if (options.infoHost === null) return jsonResponse({ error: 'info unavailable' }, 500)
      return jsonResponse({ configured: configured, aiConfigured: configured, host: options.infoHost || 'api.deepseek.com', model: 'demo-model' })
    }
    if (target.endsWith(AI_URL)) {
      events.push('ai-request')
      if (options.ai) return options.ai(call)
      return jsonResponse({ items: [] })
    }
    throw new Error('unexpected fetch: ' + target)
  }
  return { calls, events, fetch: stub }
}

function aiPosts(stub) {
  return stub.calls.filter((call) => call.method === 'POST' && call.url.endsWith(AI_URL))
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
  await import(clientUrl + '?ai=' + encodeURIComponent(tag))
  assert.ok(captured.module, 'fresh client module must register through __ModuleLoader__')
  return { mod: captured.module, nodes }
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
  return { element: React.createElement(panel.component, {}) }
}

/** Latest captured node whose prop `name` equals `value`. */
function latestNode(nodes, name, value, requireClick = true) {
  const found = nodes
    .filter((node) => node && node.props && node.props[name] === value && (!requireClick || typeof node.props.onClick === 'function'))
    .pop()
  return found || null
}

function clickNode(nodes, name, value) {
  const found = latestNode(nodes, name, value)
  assert.ok(found, `clickable ${name}=${value} must render`)
  found.props.onClick()
  return found
}

function inputNode(nodes) {
  const found = latestNode(nodes, 'data-ai-input', '1', false)
  assert.ok(found, 'AI input must render')
  return found
}

function typePrompt(nodes, text) {
  inputNode(nodes).props.onChange({ target: { value: text } })
}

async function settle(ms = 80) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function mountPanel(tag, stub, storage) {
  globalThis.localStorage = storage
  globalThis.fetch = stub.fetch
  const { mod, nodes } = await loadFreshClient(tag)
  const { element } = applyClient(mod)
  const html = await mount(element)
  return { element, html, nodes }
}

async function openAndSubmit(nodes, element, prompt = PROMPT) {
  clickNode(nodes, 'data-ai-toggle', '1')
  await mount(element)
  typePrompt(nodes, prompt)
  await mount(element)
  clickNode(nodes, 'data-ai-submit', '1')
  await mount(element)
}

// Deterministic AI payload: three trending rows whose score order is the
// REVERSE of their array order, plus one search-fallback row. If the panel
// sorted by score on the client the order assertion would fail.
function makeAiItems() {
  const first = JSON.parse(JSON.stringify(report50.repos[0]))
  const second = JSON.parse(JSON.stringify(report50.repos[1]))
  const third = JSON.parse(JSON.stringify(report50.repos[2]))
  first.matchScore = 5
  first.matchReason = '低匹配理由一'
  first.origin = 'trending'
  second.matchScore = 95
  second.matchReason = '高匹配理由二'
  second.origin = 'trending'
  third.matchScore = 50
  third.matchReason = '中匹配理由三'
  third.origin = 'trending'
  const searchRepo = {
    fullName: 'search-owner/pretty-plugin',
    name: 'pretty-plugin',
    owner: 'search-owner',
    url: 'https://github.com/search-owner/pretty-plugin',
    description: 'A beautiful DSH plugin found by GitHub search',
    stars: 1234,
    language: 'TypeScript',
    origin: 'search',
  }
  return { items: [first, second, third, searchRepo], first, second, third, searchRepo }
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

  await test('unconfigured AI: entry is disabled and a click sends zero requests', async () => {
    const stub = makeFetchStub({ configured: false })
    const storage = makeStorage()
    const { element, html, nodes } = await mountPanel('unconfigured', stub, storage)

    assert.ok(html.includes('AI 辅助筛选'), 'entry button renders')
    assert.ok(html.includes('配置 API key 后可用'), 'disabled hint renders')

    const toggle = latestNode(nodes, 'data-ai-toggle', '1')
    assert.ok(toggle, 'toggle node captured')
    assert.equal(toggle.props.disabled, true, 'entry is disabled when aiConfigured is false')

    toggle.props.onClick()
    const after = await mount(element)
    assert.equal(aiPosts(stub).length, 0, 'clicking the disabled entry sends no /ai request')
    assert.equal(stub.calls.filter((call) => call.url.endsWith('/ai')).length, 0, 'no /ai GET either')
    assert.ok(!after.includes(PROMPT), 'no input box opened')
  })

  await test('configured AI: click expands the natural-language input', async () => {
    const stub = makeFetchStub({ configured: true })
    const { element, html, nodes } = await mountPanel('expand', stub, makeStorage())
    assert.ok(!html.includes(PROMPT), 'input is collapsed by default')

    clickNode(nodes, 'data-ai-toggle', '1')
    const expanded = await mount(element)
    assert.ok(expanded.includes(PROMPT), 'placeholder carries the natural-language example')
    assert.ok(expanded.includes('筛选'), 'submit button renders')
    assert.ok(expanded.includes('清除'), 'clear button renders')

    const submit = latestNode(nodes, 'data-ai-submit', '1')
    assert.equal(submit.props.disabled, true, 'empty input disables submit')
  })

  await test('first submit pops the consent; cancel sends zero /ai requests', async () => {
    const stub = makeFetchStub({ configured: true, infoHost: 'api.deepseek.com' })
    const storage = makeStorage()
    const { element, nodes } = await mountPanel('consent-deny', stub, storage)

    await openAndSubmit(nodes, element)
    const consent = await mount(element)

    assert.ok(consent.includes('发送前确认'), 'consent dialog is shown before the first request')
    assert.ok(consent.includes('api.deepseek.com'), 'consent shows the /ai/info host')
    assert.ok(consent.includes('你输入的这句话'), 'consent explains the prompt is sent')
    assert.ok(consent.includes('topics'), 'consent explains repo topics are sent')
    assert.equal(aiPosts(stub).length, 0, 'no /ai request while the dialog is open')

    clickNode(nodes, 'data-consent-deny', '1')
    const denied = await mount(element)
    assert.ok(!denied.includes('发送前确认'), 'cancel closes the dialog')
    assert.equal(aiPosts(stub).length, 0, 'cancel sends zero /ai requests')
    assert.equal(storage.getItem(CONSENT_KEY), null, 'cancel does not record consent')
  })

  await test('consent buttons render non-empty labels and the primary rule has a contrast-safe fallback', async () => {
    const stub = makeFetchStub({ configured: true, infoHost: 'api.deepseek.com' })
    const { element, nodes } = await mountPanel('consent-contrast', stub, makeStorage())
    await openAndSubmit(nodes, element)
    const consent = await mount(element)

    assert.ok(consent.includes('同意并发送'), 'allow button text is rendered')
    assert.ok(consent.includes('不发送'), 'deny button text is rendered')

    for (const attribute of ['data-consent-allow', 'data-consent-deny']) {
      const node = latestNode(nodes, attribute, '1')
      assert.ok(node, `${attribute} must render a clickable button`)
      const label = (node.children || []).flat(Infinity).join('')
      assert.ok(label.trim().length > 0, `${attribute} must render visible text, not an empty label`)
    }

    const allow = latestNode(nodes, 'data-consent-allow', '1')
    assert.equal(allow.props['data-primary'], '1', 'allow button uses the primary style')

    const bundle = await readFile(path.resolve(rootDir, 'client.js'), 'utf8')
    const primaryRules = bundle.split('\n').filter((line) => line.includes('gt-btn[data-primary'))
    assert.ok(primaryRules.length > 0, 'the gt-btn[data-primary] rule must be present in the bundle CSS')
    for (const rule of primaryRules) {
      assert.ok(rule.includes('var(--dsw-alias-bg-base'), 'primary text colour must fall back through var(--dsw-alias-bg-base)')
      assert.ok(!/(^|[^-])color:#fff/.test(rule), 'primary rule must not hard-code color:#fff')
    }
  })

  await test('agree sends one request with the prompt, renders scores/reasons, keeps API order', async () => {
    const payload = makeAiItems()
    const stub = makeFetchStub({
      configured: true,
      infoHost: 'api.deepseek.com',
      ai: async function () {
        await settle(5)
        return jsonResponse(payload)
      },
    })
    const storage = makeStorage({}, stub.events)
    const { element, nodes } = await mountPanel('agree', stub, storage)

    await openAndSubmit(nodes, element)
    const consent = await mount(element)
    assert.ok(consent.includes('同意并发送'), 'agree button renders')
    clickNode(nodes, 'data-consent-allow', '1')
    await settle(120)
    const html = await mount(element)

    const posts = aiPosts(stub)
    assert.equal(posts.length, 1, 'exactly one /ai POST after agreeing')
    assert.equal(JSON.parse(posts[0].body).prompt, PROMPT, 'the POST carries the typed prompt')
    assert.equal(storage.getItem(CONSENT_KEY), '1', 'consent is persisted')
    assert.ok(stub.events.indexOf('consent-write') < stub.events.indexOf('ai-request'), 'consent is written before the request')

    assert.ok(html.includes('匹配度'), 'cards show the match label')
    assert.ok(html.includes('低匹配理由一'), 'the first row keeps its reason')
    assert.ok(html.includes('高匹配理由二'), 'the second row keeps its reason')
    assert.ok(html.includes('按匹配度排序'), 'the sorted-by-score hint is shown')
    assert.ok(html.includes('来自搜索 · 非本期榜单'), 'search fallback gets its own group')
    assert.ok(html.includes('data-origin="search"'), 'search cards carry the origin marker')
    assert.ok(html.includes(payload.searchRepo.fullName), 'search repo renders')
    assert.ok(html.includes('3 / 50'), 'board count stays 50 with 3 scored rows visible')

    const at1 = html.indexOf(payload.first.fullName)
    const at2 = html.indexOf(payload.second.fullName)
    const at3 = html.indexOf(payload.third.fullName)
    assert.ok(at1 >= 0 && at2 >= 0 && at3 >= 0, 'all trending rows render')
    assert.ok(at1 < at2 && at2 < at3, 'rows render in API order, not score order (5, 95, 50)')

    // A second submit after consent must not open the dialog again.
    typePrompt(nodes, '再来一次')
    await mount(element)
    clickNode(nodes, 'data-ai-submit', '1')
    await settle(120)
    const again = await mount(element)
    assert.equal(aiPosts(stub).length, 2, 'the stored consent allows the next request directly')
    assert.ok(!again.includes('发送前确认'), 'consent dialog is not shown again')
  })

  await test('412 / 403 / 429 / timeout show one readable line and keep the board', async () => {
    const scenarios = [
      { tag: '412', status: 412, text: '未配置 key' },
      { tag: '403', status: 403, text: '跨源请求被拒' },
      { tag: '429', status: 429, text: '请求太频繁，请稍后再试' },
      { tag: 'timeout', abort: true, text: '请求超时，请稍后重试' },
    ]
    for (const scenario of scenarios) {
      const stub = makeFetchStub({
        configured: true,
        ai: async function () {
          if (scenario.abort) {
            const error = new Error('aborted')
            error.name = 'AbortError'
            throw error
          }
          return jsonResponse({ error: 'failed' }, scenario.status)
        },
      })
      const storage = makeStorage({ [CONSENT_KEY]: '1' })
      const { element, nodes } = await mountPanel('error-' + scenario.tag, stub, storage)
      await openAndSubmit(nodes, element)
      await settle(80)
      const html = await mount(element)

      assert.ok(html.includes(scenario.text), `${scenario.tag} shows "${scenario.text}"`)
      assert.equal(aiPosts(stub).length, 1, `${scenario.tag} attempted exactly one request`)
      assert.ok(html.includes(report50.repos[0].fullName), `${scenario.tag} keeps the original board`)
      assert.ok(!html.includes('匹配度'), `${scenario.tag} adds no match badges`)
    }
  })

  await test('clear restores the original board (no match badges, no search group)', async () => {
    const payload = makeAiItems()
    const stub = makeFetchStub({ configured: true, ai: async () => jsonResponse(payload) })
    const storage = makeStorage({ [CONSENT_KEY]: '1' })
    const { element, nodes } = await mountPanel('clear', stub, storage)

    await openAndSubmit(nodes, element)
    await settle(80)
    const filtered = await mount(element)
    assert.ok(filtered.includes('匹配度'), 'AI result applied first')
    assert.ok(filtered.includes('来自搜索 · 非本期榜单'), 'search group applied first')

    clickNode(nodes, 'data-ai-clear', '1')
    const cleared = await mount(element)
    assert.ok(!cleared.includes('匹配度'), 'match badges are gone')
    assert.ok(!cleared.includes('来自搜索 · 非本期榜单'), 'search group is gone')
    assert.ok(!cleared.includes('按匹配度排序'), 'sorted hint is gone')
    assert.ok(cleared.includes(report50.repos[0].fullName), 'original board is back')
  })

  await test('first run: the onboarding dialog shows the exact three options and remembers dismissal', async () => {
    const FIRST_RUN_KEY = 'dsh-github-trending:first-run'
    const stub = makeFetchStub({ configured: true, githubTokenConfigured: true })
    const storage = makeStorage()
    const { element, html, nodes } = await mountPanel('first-run', stub, storage)

    assert.ok(html.includes('要不要配置以下功能（强烈推荐）'), 'onboarding title is rendered')
    assert.ok(html.includes('① 什么都不配（默认）'), 'option 1 heading is rendered')
    assert.ok(html.includes('能看日/周/月趋势榜、13 个固定分类'), 'option 1 body is rendered')
    assert.ok(html.includes('② 配 GitHub token（可选，只读）'), 'option 2 heading is rendered')
    assert.ok(html.includes('配额 60 → 5000 次/小时'), 'option 2 body is rendered')
    assert.ok(html.includes('③ 配 AI key（可选）'), 'option 3 heading is rendered')
    assert.ok(html.includes('每次筛选不到一分钱'), 'option 3 body is rendered')
    assert.ok(html.includes('（v4.1f）'), 'option 3 pricing carries its version tag')
    assert.ok(html.includes('注：打开后要等一会儿'), 'the wait note is rendered with its 注 prefix')
    assert.ok(html.includes('AI 写的项目介绍要等完整信息到了才发请求'), 'the wait note explains the late model intro')
    assert.ok(html.includes('Steam++ 会比一般梯子慢一些'), 'the wait note calls out the accelerator')
    assert.ok(latestNode(nodes, 'data-first-run-wait', '1', false), 'the wait note is its own element')
    assert.ok(html.includes('先这样用'), 'dismiss button is rendered')
    assert.ok(html.includes('去看怎么配'), 'tutorial button is rendered')
    assert.ok(html.includes('下次不再提示'), 'remember checkbox is rendered')
    assert.ok(html.includes('（教程在页面末尾）'), 'the checkbox line advertises where the tutorial is')
    const note = latestNode(nodes, 'data-first-run-note', '1', false)
    assert.ok(note, 'the location note is its own element')
    assert.equal(note.props.className, 'gt-firstrun-note', 'the note uses the gt-firstrun-note class')
    assert.equal((note.children || []).flat(Infinity).join(''), '（教程在页面末尾）', 'the note keeps its exact copy')
    assert.equal(storage.getItem(FIRST_RUN_KEY), null, 'opening the dialog writes nothing')

    const remember = latestNode(nodes, 'data-first-run-remember', '1', false)
    assert.ok(remember, 'remember checkbox node captured')
    remember.props.onChange({ target: { checked: true } })
    await mount(element)
    clickNode(nodes, 'data-first-run-use', '1')
    const closed = await mount(element)
    assert.ok(!closed.includes('要不要配置以下功能（强烈推荐）'), 'dismiss closes the dialog')
    assert.equal(storage.getItem(FIRST_RUN_KEY), '1', 'the ticked checkbox is remembered')

    const remembered = await mountPanel('first-run-remembered', stub, storage)
    assert.ok(!remembered.html.includes('要不要配置以下功能（强烈推荐）'), 'a stored flag keeps the dialog closed')

    const noRememberStorage = makeStorage()
    const noRemember = await mountPanel('first-run-no-remember', stub, noRememberStorage)
    clickNode(noRemember.nodes, 'data-first-run-use', '1')
    await mount(noRemember.element)
    assert.equal(noRememberStorage.getItem(FIRST_RUN_KEY), null, 'dismissing without ticking writes nothing')
  })

  await test('first run: "去看怎么配" closes the dialog, expands the tutorial and scrolls to it', async () => {
    const FIRST_RUN_KEY = 'dsh-github-trending:first-run'
    const stub = makeFetchStub({ configured: true, githubTokenConfigured: true })
    const storage = makeStorage()
    const { element, nodes } = await mountPanel('first-run-help', stub, storage)

    const scrollCalls = []
    const flashClasses = new Set()
    const tutorialNode = {
      classList: {
        add(name) { flashClasses.add(name) },
        remove(name) { flashClasses.delete(name) },
      },
      scrollIntoView(options) { scrollCalls.push(options) },
    }
    const queries = []
    const previousDocument = globalThis.document
    // A zero-request DOM stub: the client must find `[data-ai-help]`, scroll it
    // once and flash it. No real browser (or network) is involved.
    globalThis.document = {
      querySelector(selector) {
        queries.push(selector)
        return tutorialNode
      },
    }
    try {
      clickNode(nodes, 'data-first-run-help', '1')
      await settle(100)
      const after = await mount(element)
      assert.ok(!after.includes('要不要配置以下功能（强烈推荐）'), 'tutorial button closes the dialog')
      assert.ok(after.includes('setx GITHUB_TOKEN'), 'tutorial is expanded with the GitHub token command')
      assert.ok(after.includes('%USERPROFILE%\\.dsh\\github-token'), 'tutorial shows the token file path')
      assert.equal(
        latestNode(nodes, 'data-ai-help-toggle', '1', false).props['aria-expanded'],
        'true',
        'the tutorial section is expanded (aria-expanded="true")',
      )
      assert.deepEqual(queries, ['[data-ai-help]'], 'the tutorial node is looked up once by its data attribute')
      assert.equal(scrollCalls.length, 1, 'scrollIntoView is called exactly once')
      assert.deepEqual(scrollCalls[0], { behavior: 'smooth', block: 'start' }, 'the scroll is smooth and pins the tutorial top')
      assert.ok(flashClasses.has('gt-flash'), 'the tutorial gets the temporary gt-flash class')
      assert.equal(storage.getItem(FIRST_RUN_KEY), null, 'the tutorial button alone does not write the memory key')
    } finally {
      globalThis.document = previousDocument
    }
  })

  await test('first run: a missing tutorial node shows the top hint and never throws', async () => {
    const stub = makeFetchStub({ configured: true, githubTokenConfigured: true })
    const { element, nodes } = await mountPanel('first-run-hint', stub, makeStorage())

    const previousDocument = globalThis.document
    // querySelector exists but no tutorial is mounted: the fallback path must
    // set helpHint instead of throwing or silently doing nothing.
    globalThis.document = {
      querySelector() { return null },
    }
    try {
      assert.doesNotThrow(() => clickNode(nodes, 'data-first-run-help', '1'), 'the click must not throw')
      await settle(100)
      const after = await mount(element)
      assert.ok(after.includes('data-help-hint="1"'), 'a hint bar renders at the top of the panel')
      assert.ok(after.includes('配置教程在页面最底部，向下滚动即可看到'), 'the hint says where the tutorial is')
      assert.ok(after.includes('去底部'), 'the hint offers a jump button')
      assert.ok(after.includes('data-help-hint-go="1"'), 'the jump button is addressable')
      assert.ok(!after.includes('要不要配置以下功能（强烈推荐）'), 'the dialog still closes')
      assert.equal(
        latestNode(nodes, 'data-ai-help-toggle', '1', false).props['aria-expanded'],
        'true',
        'the tutorial is still expanded even without a DOM node',
      )
    } finally {
      globalThis.document = previousDocument
    }
  })

  await test('first run: no document at all also falls back to the hint', async () => {
    const stub = makeFetchStub({ configured: true, githubTokenConfigured: true })
    const { element, nodes } = await mountPanel('first-run-hint-nodoc', stub, makeStorage())

    const previousDocument = globalThis.document
    globalThis.document = undefined
    try {
      assert.doesNotThrow(() => clickNode(nodes, 'data-first-run-help', '1'), 'the click must not throw without a document')
      await settle(100)
      const after = await mount(element)
      assert.ok(after.includes('data-help-hint="1"'), 'the hint bar still renders without a document')
      assert.ok(after.includes('配置教程在页面最底部，向下滚动即可看到'), 'the fallback copy is unchanged')
    } finally {
      globalThis.document = previousDocument
    }
  })

  await test('config tutorial is collapsed by default; expanding shows both step-by-step guides and statuses', async () => {
    const stub = makeFetchStub({ configured: true, githubTokenConfigured: true })
    const { element, html, nodes } = await mountPanel('help', stub, makeStorage())

    assert.ok(html.includes('怎么配置（小白也能照着做）'), 'tutorial heading renders')
    assert.ok(html.includes('GitHub token：已配置'), 'GitHub token status line renders')
    assert.ok(html.includes('AI key：已配置'), 'AI key status line renders')
    assert.ok(!html.includes('DSH_GITHUB_TRENDING_AI_KEY'), 'tutorial body is collapsed by default')
    assert.ok(!html.includes('setx GITHUB_TOKEN'), 'GitHub token steps are collapsed by default')

    clickNode(nodes, 'data-ai-help-toggle', '1')
    const expanded = await mount(element)
    assert.ok(expanded.includes('DSH_GITHUB_TRENDING_AI_KEY'), 'AI key env var is documented')
    assert.ok(expanded.includes('setx GITHUB_TOKEN'), 'GitHub token env command is documented')
    assert.ok(expanded.includes('%USERPROFILE%\\.dsh\\github-token'), 'GitHub token file path is documented')
    assert.ok(expanded.includes('%USERPROFILE%\\.dsh\\github-trending-ai-key'), 'AI key file path is documented')
    assert.ok(expanded.includes('aiBaseURL'), 'aiBaseURL is documented')
    assert.ok(expanded.includes('deepseek-flash'), 'default model is documented')
    assert.ok(expanded.includes('401/403'), 'GitHub token FAQ is documented')
    assert.ok(
      expanded.includes('到期后重新生成一次') && expanded.includes('token 过期后'),
      'the token guide explains expiration/regeneration and what an expired token looks like',
    )
    assert.ok(expanded.includes('复制命令'), 'copy buttons are labelled')
    assert.ok(expanded.includes('data-help-copy="github"'), 'GitHub token block has a copy button')
    assert.ok(expanded.includes('data-help-copy="ai"'), 'AI key block has a copy button')

    const offStub = makeFetchStub({ configured: false, githubTokenConfigured: false })
    const off = await mountPanel('help-off', offStub, makeStorage())
    const offCollapsed = await mount(off.element)
    assert.ok(offCollapsed.includes('GitHub token：未配置'), 'GitHub token status is unconfigured without a token')
    assert.ok(offCollapsed.includes('AI key：未配置'), 'unconfigured AI status is shown when no key exists')
  })

  await test('unusable storage asks every time and never crashes', async () => {
    const stub = makeFetchStub({ configured: true, ai: async () => jsonResponse({ items: [] }) })
    const boom = function () {
      throw new Error('storage denied')
    }
    const storage = { getItem: boom, setItem: boom, removeItem: boom }
    const { element, nodes } = await mountPanel('storage-boom', stub, storage)

    await openAndSubmit(nodes, element, '第一次')
    assert.ok((await mount(element)).includes('发送前确认'), 'first submit asks for consent')
    clickNode(nodes, 'data-consent-allow', '1')
    await settle(80)
    assert.equal(aiPosts(stub).length, 1, 'consent still sends the first request')

    typePrompt(nodes, '第二次')
    await mount(element)
    clickNode(nodes, 'data-ai-submit', '1')
    const second = await mount(element)
    assert.ok(second.includes('发送前确认'), 'a throwing storage falls back to asking every time')
    assert.equal(aiPosts(stub).length, 1, 'no request before the second consent')

    clickNode(nodes, 'data-consent-allow', '1')
    await settle(80)
    assert.equal(aiPosts(stub).length, 2, 'second consent sends the second request')
  })

  await test('missing /ai/info host falls back to the generic label', async () => {
    const stub = makeFetchStub({ configured: true, infoHost: null })
    const { element, nodes } = await mountPanel('host-fallback', stub, makeStorage())
    await openAndSubmit(nodes, element)
    const consent = await mount(element)

    assert.ok(consent.includes('发送前确认'), 'consent still opens')
    assert.ok(consent.includes('已配置的接口地址'), 'fallback host label is used')
  })
} finally {
  globalThis.fetch = undefined
  globalThis.localStorage = undefined
  const failed = outcomes.filter((outcome) => !outcome.ok)
  console.log('')
  console.log(`${outcomes.length - failed.length}/${outcomes.length} tests passed`)
  if (failed.length > 0) process.exitCode = 1
}
