#!/usr/bin/env node
/**
 * Offline tests for the Task-3 category catalogue.
 *
 * The whole file is pure functions over one JSON fixture: no network, no
 * enrichment, no GitHub API. Run with:
 *
 *   node build.mjs && node test/categories.test.mjs --fixture test/fixtures/repos/categories.json
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CATEGORY_CATALOG, classifyAll, classifyAllScored } from '../lib/categories.js'
import { analyzeRepo } from '../lib/analyze.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(here, '..')

function argumentValue(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  return fallback
}

const fixturePath = path.resolve(rootDir, argumentValue('--fixture', 'test/fixtures/repos/categories.json'))

const EXPECTED_KEYS = [
  'ai',
  'devtool',
  'web',
  'infra',
  'data',
  'security',
  'mobile',
  'blockchain',
  'learning',
  'productivity',
  'game',
  'hardware',
  'research',
]

// Guard rail: this test must stay offline. Any direct `fetch` attempt is a
// failure, not a slow network timeout.
globalThis.fetch = async () => {
  throw new Error('categories.test.mjs must not touch the network')
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

function label(rule) {
  return { key: rule.key, zh: rule.zh, en: rule.en }
}

try {
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
  const cases = Array.isArray(fixture.cases) ? fixture.cases : []
  assert.ok(cases.length >= 3, 'fixture needs at least three repository cases')

  await test('catalogue is the fixed 13-bucket set and contains no "other"', () => {
    assert.ok(CATEGORY_CATALOG.length >= 13, 'catalogue must keep at least the 13 buckets')
    assert.equal(CATEGORY_CATALOG.length, 13)
    assert.deepEqual(CATEGORY_CATALOG.map((rule) => rule.key), EXPECTED_KEYS)
    assert.equal(new Set(CATEGORY_CATALOG.map((rule) => rule.key)).size, 13, 'keys must be unique')
    assert.ok(!CATEGORY_CATALOG.some((rule) => rule.key === 'other'), 'the "other" fallback must be gone')
    const learning = CATEGORY_CATALOG.find((rule) => rule.key === 'learning')
    assert.ok(learning, 'learning bucket is required')
    assert.ok(learning.zh.includes('学习'), 'learning zh name must be 学习')
  })

  await test('every fixture case returns exactly its expected labels, primary first', () => {
    for (const item of cases) {
      const hits = classifyAll(item.repo, item.facts)
      assert.deepEqual(hits.map((rule) => rule.key), item.expected.keys, item.name)
      assert.ok(hits.length <= 3, `${item.name} must cap at three labels`)
      if (hits.length > 0) assert.equal(hits[0].key, item.expected.primary, `${item.name} primary`)
    }
  })

  await test('only rules scoring at least 1.5 are labels, ordered by score', () => {
    for (const item of cases) {
      const scored = classifyAllScored(item.repo, item.facts)
      assert.ok(scored.length <= 3, `${item.name} score list must cap at three`)
      scored.forEach((hit) => assert.ok(hit.score >= 1.5, `${item.name}: ${hit.rule.key} scored ${hit.score}`))
      for (let index = 1; index < scored.length; index += 1) {
        assert.ok(scored[index - 1].score >= scored[index].score, `${item.name} must be score ordered`)
      }
    }
  })

  await test('a repo hitting both AI and learning returns two labels with AI primary', () => {
    const item = cases.find((entry) => entry.expected.keys.includes('ai') && entry.expected.keys.includes('learning'))
    assert.ok(item, 'fixture must contain an AI + learning repository')
    const keys = classifyAll(item.repo, item.facts).map((rule) => rule.key)
    assert.equal(keys.length, 2)
    assert.deepEqual(keys, ['ai', 'learning'])
  })

  await test('a repo with no matching evidence returns an empty array', () => {
    const item = cases.find((entry) => entry.expected.keys.length === 0)
    assert.ok(item, 'fixture must contain an uncategorised repository')
    assert.deepEqual(classifyAll(item.repo, item.facts), [])
  })

  await test('analyzeRepo exposes categories and keeps category as the top label', () => {
    const item = cases.find((entry) => entry.expected.keys.includes('ai') && entry.expected.keys.includes('learning'))
    assert.ok(item)
    const analyzed = analyzeRepo(item.repo, item.facts, { since: 'daily' })
    assert.deepEqual(analyzed.categories.map((entry) => entry.key), item.expected.keys)
    assert.deepEqual(analyzed.categories[0], label(CATEGORY_CATALOG.find((rule) => rule.key === 'ai')))
    assert.equal(analyzed.category, item.expected.primary)
    assert.equal(analyzed.categoryZh, analyzed.categories[0].zh)
    assert.equal(analyzed.categoryEn, analyzed.categories[0].en)
    assert.equal(analyzed.source, item.repo.source ?? null, 'Task-2 source field must survive')
  })

  await test('analyzeRepo handles an uncategorised repo without inventing an "other" bucket', () => {
    const item = cases.find((entry) => entry.expected.keys.length === 0)
    assert.ok(item)
    const analyzed = analyzeRepo(item.repo, item.facts, { since: 'daily' })
    assert.deepEqual(analyzed.categories, [])
    assert.equal(analyzed.category, '')
    assert.equal(analyzed.categoryZh, '')
    assert.equal(analyzed.categoryEn, '')
    const narrative = [analyzed.intro, analyzed.tldr, ...analyzed.deepDive.map((block) => block.text)].join('\n')
    assert.ok(!narrative.includes('其他'), 'uncategorised prose must not mention 其他')
    assert.ok(!narrative.includes('other'), 'uncategorised prose must not mention other')
  })

  await test('a repo matching four or more buckets is capped at three', () => {
    const item = cases.find((entry) => entry.expected.keys.length === 3)
    assert.ok(item, 'fixture must contain a capped repository')
    const hits = classifyAll(item.repo, item.facts)
    assert.equal(hits.length, 3)
    assert.equal(hits[0].key, 'ai')
  })
} finally {
  // Keep the intentional fetch stub out of the process footprint.
  globalThis.fetch = undefined

  const failed = outcomes.filter((outcome) => !outcome.ok)
  console.log('')
  console.log(`${outcomes.length - failed.length}/${outcomes.length} tests passed`)
  if (failed.length > 0) {
    process.exitCode = 1
  }
}
