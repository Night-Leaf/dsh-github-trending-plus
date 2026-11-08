#!/usr/bin/env node
/**
 * Offline tests for Task-6 card layering.
 *
 * The panel decides `deep` vs `simple` from the GLOBAL list index and the
 * report's `deepCount` (default 10), not from the page-local index. With the
 * 50-repo fixture that means: page 1 = 6 deep, page 2 = 4 deep + 2 simple,
 * page 3 = 6 simple. Deep cards render every deepDive block plus up to three
 * AI-model chips and the Chinese-README badge; simple cards render no
 * `gt-block`. `source:'popular'` cards carry the "全语言榜" marker in both modes.
 *
 * Each page is rendered through a fresh module instance of `client.js`, so the
 * React shim's per-component hook store starts empty for every mount.
 *
 * Run with:
 *
 *   node build.mjs && node test/client-cards.test.mjs --fixture test/fixtures/client/report-50.json
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

const fixturePath = path.resolve(rootDir, argumentValue('--fixture', 'test/fixtures/client/report-50.json'))
const report50 = JSON.parse(await readFile(fixturePath, 'utf8'))
const clientUrl = pathToFileURL(path.resolve(rootDir, 'client.js')).href

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

/** The client is a plain script that calls `window.__ModuleLoader__.load`. */
async function loadClientModule(tag) {
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
  await import(clientUrl + '?page=' + encodeURIComponent(tag))
  assert.ok(captured.module, 'client module must register through __ModuleLoader__')
  return captured.module
}

/** Load the client, register its slots and mount the main panel on one page. */
async function mountPage(page, payload = report50) {
  const mod = await loadClientModule('p' + page)
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

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  })

  // A fresh wrapper type per mount keeps an explicit initial page from being
  // overwritten by the "filters changed" reset effect.
  const Wrapper = function CardsPage(props) {
    return React.createElement(panel.component, props)
  }
  return mount(React.createElement(Wrapper, { initialPage: page }))
}

function articles(html) {
  return html.match(/<article class="gt-repo gt-repo-(?:deep|simple)">[\s\S]*?<\/article>/g) || []
}

function deepArticles(html) {
  return articles(html).filter((article) => article.indexOf('gt-repo-deep') >= 0)
}

function simpleArticles(html) {
  return articles(html).filter((article) => article.indexOf('gt-repo-simple') >= 0)
}

function articleFor(html, fullName) {
  const found = articles(html).find((article) => article.indexOf(fullName) >= 0)
  assert.ok(found, `card for ${fullName} must render`)
  return found
}

let page1
let page2
let page3

try {
  await test('report fixture carries deepCount=10 and the card CSS classes', async () => {
    assert.equal(report50.deepCount, 10)
    assert.equal(report50.repos.length, 50)
    page1 = await mountPage(1)
    for (const cssClass of ['gt-repo-deep', 'gt-repo-simple', 'gt-badge-zh', 'gt-model', 'gt-source']) {
      assert.ok(page1.includes('.' + cssClass), `CSS must define .${cssClass}`)
    }
  })

  await test('page 1 renders 6 deep cards and no simple cards', () => {
    assert.equal(deepArticles(page1).length, 6)
    assert.equal(simpleArticles(page1).length, 0)
  })

  await test('page 2 renders 4 deep + 2 simple cards (global index, not page index)', async () => {
    page2 = await mountPage(2)
    assert.equal(deepArticles(page2).length, 4, 'ranks 7-10 are still deep')
    assert.equal(simpleArticles(page2).length, 2, 'ranks 11-12 are simple')
    // If mode were computed from the page-local index, page 2 would be 6 deep.
    assert.equal(articles(page2).length, 6)
  })

  await test('page 3 renders 6 simple cards and no deep cards', async () => {
    page3 = await mountPage(3)
    assert.equal(deepArticles(page3).length, 0)
    assert.equal(simpleArticles(page3).length, 6)
  })

  await test('simple cards never render gt-block', () => {
    for (const [label, html] of [['page2', page2], ['page3', page3]]) {
      for (const article of simpleArticles(html)) {
        assert.ok(!article.includes('gt-block'), `${label}: simple card must not render gt-block`)
      }
    }
    assert.equal((page3.match(/class="gt-block"/g) || []).length, 0)
  })

  await test('deep cards keep the deepDive blocks', () => {
    for (const article of deepArticles(page1)) {
      assert.ok(article.includes('class="gt-block"'), 'deep card renders deepDive')
      assert.ok(article.includes('项目定位'), 'deepDive content is present')
    }
  })

  await test('AI card shows at most three model chips after the AI category tag', () => {
    const article = articleFor(page1, 'octo-labs/llm-agent-kit')
    const models = (article.match(/class="gt-tag gt-model"/g) || []).length
    assert.ok(models <= 3, `model chips must be <= 3, got ${models}`)
    assert.equal(models, 3, 'the fixture lists four models, so exactly three render')
    assert.ok(article.indexOf('AI / 大模型') >= 0, 'AI category tag present')
    assert.ok(article.indexOf('gt-model') > article.indexOf('AI / 大模型'), 'model chips follow the AI tag')
    for (const model of ['GPT-4o', 'Claude 3.5 Sonnet', 'Gemini 1.5 Pro']) {
      assert.ok(article.includes(model), `model ${model}`)
    }
    assert.ok(!article.includes('Llama 3'), 'the fourth model is truncated')
  })

  await test('non-AI deep card renders no model chips', () => {
    const article = articleFor(page1, 'web-studio/react-canvas')
    assert.equal((article.match(/class="gt-tag gt-model"/g) || []).length, 0)
  })

  await test('Chinese-README deep cards show the badge, simple cards do not', () => {
    const deep = articleFor(page1, 'octo-labs/llm-agent-kit')
    assert.ok(deep.includes('gt-badge-zh'), 'deep Chinese-README card has the badge')
    assert.ok(deep.includes('中文 README'), 'badge text')

    const simple = articleFor(page2, 'owner-11/project-11')
    assert.ok(simple.includes('gt-repo-simple'))
    assert.ok(!simple.includes('gt-badge-zh'), 'simple card must not render the Chinese-README badge')
  })

  await test('source:popular cards carry the "全语言榜" marker in both modes', () => {
    const deepPopular = articleFor(page1, 'data-forge/rust-query-engine')
    assert.ok(deepPopular.includes('gt-source'), 'deep popular card has the source marker')
    assert.ok(deepPopular.includes('全语言榜'), 'marker text')

    const deepLanguage = articleFor(page1, 'sec-labs/secure-scan')
    assert.ok(!deepLanguage.includes('gt-source'), 'language card has no source marker')
    assert.ok(!deepLanguage.includes('全语言榜'))

    const simplePopular = articleFor(page3, 'owner-15/project-15')
    assert.ok(simplePopular.includes('gt-repo-simple'))
    assert.ok(simplePopular.includes('全语言榜'), 'simple popular card keeps the marker')

    const simpleLanguage = articleFor(page3, 'owner-16/project-16')
    assert.ok(!simpleLanguage.includes('全语言榜'))
  })
} finally {
  globalThis.fetch = undefined
  globalThis.window = undefined

  const failed = outcomes.filter((outcome) => !outcome.ok)
  console.log('')
  console.log(`${outcomes.length - failed.length}/${outcomes.length} tests passed`)
  if (failed.length > 0) process.exitCode = 1
}
