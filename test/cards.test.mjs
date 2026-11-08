#!/usr/bin/env node
/**
 * Offline tests for the Task-5 card content:
 *
 *   - "项目介绍" is at most two sentences and carries no growth figures
 *   - "增长曲线" / "值得关注" are gone; "技术栈" / "需要留意" / "上手门槛" remain
 *   - AI model chips are evidence based, capped at three, empty for non-AI repos
 *   - Chinese README detection tries the fixed candidate list
 *   - `enrichRepos` only spends API calls on the first N repositories
 *
 * Run with:
 *
 *   node build.mjs && node test/cards.test.mjs --fixture test/fixtures/repos/cards.json
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { analyzeRepo } from '../lib/analyze.js'
import { detectAiModels } from '../lib/ai-models.js'
import { README_CANDIDATES, clearEnrichCache, enrichRepos } from '../lib/enrich.js'
import { clearReportCache, getReport } from '../lib/report.js'
import { TOPIC_GLOSSARY, hasCjk } from '../lib/zh.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(here, '..')

function argumentValue(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  return fallback
}

const fixturePath = path.resolve(rootDir, argumentValue('--fixture', 'test/fixtures/repos/cards.json'))

// Guard rail: this test must stay offline. The real transport's `fetch` is
// replaced with a sentinel; every enrichment below injects its own fetcher.
const realFetch = globalThis.fetch
globalThis.fetch = async () => {
  throw new Error('cards.test.mjs must not touch the network')
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

function analyze(card) {
  return analyzeRepo(card.repo, card.facts, { since: 'daily' })
}

function labels(analyzed) {
  return analyzed.deepDive.map((block) => block.label)
}

function blockText(analyzed, label) {
  const block = analyzed.deepDive.find((entry) => entry.label === label)
  return block ? block.text : ''
}

function sentenceCount(text) {
  return text
    .split(/[。！？!?]+/)
    .map((part) => part.trim())
    .filter(Boolean).length
}

/** Whitelisted acronyms/professional terms allowed in a Chinese-only 项目介绍. */
const ALLOWED_LATIN = /\b(?:AI|LLM|RAG|CLI|API|SDK|MCP|GPU|UI|3D|SQL|OAuth|Markdown|PDF|Word)\b/gi

/**
 * Remove proper nouns (repository name, language) and whitelisted acronyms so
 * the rest can be checked for stray English words.
 */
function leftoverLatin(text, repo) {
  let rest = text
  for (const proper of [repo.name, repo.language].filter(Boolean)) {
    rest = rest.split(proper).join(' ')
  }
  return rest.replace(ALLOWED_LATIN, ' ')
}

/**
 * Fake enrichment transport. API URLs answer with one enriched payload; README
 * URLs answer from the `readme` map (`fullName|path`, or `fullName|ref|path`)
 * and 404 otherwise. `options.apiStatus` simulates an exhausted API quota and
 * `options.rawError` simulates a raw-channel timeout.
 */
function makeFetcher(options = {}) {
  const apiCalls = []
  const apiReadmeCalls = []
  const readmeCalls = []
  const readmeTimeouts = []
  const apiStatus = options.apiStatus ?? 200
  const payload = options.apiPayload ?? {
    topics: ['cli'],
    license: { spdx_id: 'MIT' },
    archived: false,
    created_at: '2025-01-01T00:00:00Z',
    pushed_at: '2026-01-01T00:00:00Z',
    open_issues_count: 2,
    homepage: null,
  }
  const readme = options.readme ?? new Map()
  const apiReadme = options.apiReadme ?? new Map()
  return {
    apiCalls,
    apiReadmeCalls,
    readmeCalls,
    readmeTimeouts,
    fetcher: async (url, init = {}) => {
      if (/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/readme$/.test(url)) {
        apiReadmeCalls.push(url)
        if (apiStatus !== 200) return { status: apiStatus, text: 'rate limited', via: 'direct' }
        const fullName = url.slice('https://api.github.com/repos/'.length, -'/readme'.length)
        const entry = apiReadme.get(fullName)
        if (!entry) return { status: 404, text: 'not found', via: 'direct' }
        return {
          status: 200,
          text: JSON.stringify({
            path: entry.path ?? 'README.md',
            encoding: 'base64',
            content: Buffer.from(entry.body, 'utf8').toString('base64'),
          }),
          via: 'direct',
        }
      }
      if (url.startsWith('https://api.github.com/repos/')) {
        apiCalls.push(url)
        if (apiStatus !== 200) return { status: apiStatus, text: 'rate limited', via: 'direct' }
        return { status: 200, text: JSON.stringify(payload), via: 'direct' }
      }
      if (url.startsWith('https://raw.githubusercontent.com/')) {
        readmeCalls.push(url)
        const match = /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/(HEAD|main|master)\/(.+)$/.exec(url)
        assert.ok(match, `unexpected README URL: ${url}`)
        readmeTimeouts.push(init.timeoutMs)
        if (options.rawError) throw options.rawError
        const body = readme.get(`${match[1]}|${match[2]}|${match[3]}`) ?? readme.get(`${match[1]}|${match[3]}`)
        if (body === undefined) return { status: 404, text: 'not found', via: 'direct' }
        return { status: 200, text: body, via: 'direct' }
      }
      throw new Error(`cards.test.mjs received an unexpected URL: ${url}`)
    },
  }
}

/** Minimal trending repository for the README-channel tests. */
function readmeRepo(fullName, extra = {}) {
  const [owner, name] = fullName.split('/')
  return {
    rank: 1,
    owner,
    name,
    fullName,
    url: `https://github.com/${fullName}`,
    description: 'README channel test repository.',
    language: 'TypeScript',
    languageColor: null,
    stars: 10,
    forks: 1,
    delta: 1,
    contributors: [],
    ...extra,
  }
}


try {
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
  const cards = Array.isArray(fixture.cards) ? fixture.cards : []
  assert.ok(cards.length >= 3, 'fixture needs at least three card cases')

  await test('deepDive drops 增长曲线/值得关注 and keeps 技术栈/需要留意/上手门槛', () => {
    for (const card of cards) {
      const actual = labels(analyze(card))
      assert.ok(!actual.includes('增长曲线'), `${card.name} must not render 增长曲线`)
      assert.ok(!actual.includes('值得关注'), `${card.name} must not render 值得关注`)
      for (const label of card.expected.labels) {
        assert.ok(actual.includes(label), `${card.name} must keep ${label}`)
      }
      for (const label of card.expected.forbiddenLabels) {
        assert.ok(!actual.includes(label), `${card.name} must not render ${label}`)
      }
      assert.ok(!actual.includes('适合谁'), `${card.name} must replace 适合谁 with 上手门槛`)
    }
  })

  await test('deepDive never renders README 摘要', () => {
    for (const card of cards) {
      assert.ok(!labels(analyze(card)).includes('README 摘要'), `${card.name} must not render README 摘要`)
    }
  })

  await test('项目介绍 is at most two sentences and has no star/fork/growth figures', () => {
    for (const card of cards) {
      const text = blockText(analyze(card), '项目介绍')
      assert.ok(text.length > 0, `${card.name} needs a 项目介绍 block`)
      assert.ok(sentenceCount(text) <= 2, `${card.name} 项目介绍 has too many sentences: ${text}`)
      assert.ok(!/\d[\d,.]*\s*(star|fork)/i.test(text), `${card.name} 项目介绍 must not repeat star/fork counts`)
      assert.ok(!/增长率|贡献者/.test(text), `${card.name} 项目介绍 must not repeat growth/contributor figures`)
    }
  })

  await test('AI repository gets exactly three evidence-based model chips', () => {
    for (const card of cards) {
      const analyzed = analyze(card)
      assert.deepEqual(analyzed.aiModels, card.expected.models, card.name)
      assert.ok(analyzed.aiModels.length <= 3, `${card.name} must cap model chips at three`)
      const evidence = [card.repo.name, card.repo.description, card.facts.topics.join(' '), card.facts.readmeSnippet ?? '']
        .join(' ')
        .toLowerCase()
      for (const model of analyzed.aiModels) {
        assert.ok(evidence.includes(model.toLowerCase()), `${card.name}: ${model} has no evidence in the repository text`)
      }
    }
    // The alias table itself must cap and must never invent names for non-AI repos.
    assert.equal(detectAiModels({ name: 'x', description: 'GPT-4o Claude Gemini Llama', topics: [], readmeSnippet: null }, true).length, 3)
    assert.deepEqual(detectAiModels({ name: 'x', description: 'GPT-4o Claude', topics: [], readmeSnippet: null }, false), [])
  })

  await test('上手门槛: resource repos get the fixed sentence, runnable repos start with 需要先会, no time estimates', () => {
    for (const card of cards) {
      const analyzed = analyze(card)
      const text = blockText(analyzed, '上手门槛')
      if (card.expected.hasOnboarding) {
        assert.ok(text.length > 0, `${card.name} must render 上手门槛`)
        assert.ok(text.startsWith('需要先会：'), `${card.name} 上手门槛 must start with 需要先会：, got: ${text}`)
        assert.ok(text.includes('第一次能跑到：'), `${card.name} 上手门槛 must answer how far the first run gets`)
        assert.ok(!/小时|半天|分钟|天/.test(text), `${card.name} 上手门槛 must not estimate time: ${text}`)
      } else {
        assert.equal(text, '', `${card.name} must omit 上手门槛 without evidence`)
        const narrative = analyzed.deepDive.map((block) => block.text).join('\n')
        assert.ok(!narrative.includes('未知'), `${card.name} must not fall back to an "未知" placeholder`)
      }
    }

    const RESOURCE_TEXT = '为特定专业领域的学术资源，直接浏览即可，无需安装。'
    const base = cards[0]
    const resourceCases = [
      {
        name: 'name keyword: awesome',
        repo: { ...base.repo, name: 'awesome-python', fullName: 'acme/awesome-python', description: 'A hand-picked toolkit.' },
        facts: { topics: [] },
      },
      {
        name: 'description keyword: curated list',
        repo: { ...base.repo, name: 'ml-basics', fullName: 'acme/ml-basics', description: 'A curated list of machine learning papers.' },
        facts: { topics: [] },
      },
      {
        name: 'topic keyword: tutorial',
        repo: { ...base.repo, name: 'starter', fullName: 'acme/starter', description: 'Starter material for new contributors.' },
        facts: { topics: ['tutorial'] },
      },
      {
        name: '中文名称: 教程',
        repo: { ...base.repo, name: 'python-教程', fullName: 'acme/python-教程', description: '面向初学者的入门材料。' },
        facts: { topics: [], readmeSnippet: null, enriched: false },
      },
      {
        name: '中文 description: 书单',
        repo: { ...base.repo, name: 'reading', fullName: 'acme/reading', description: '一份后端开发书单。' },
        facts: { topics: [] },
      },
    ]
    for (const item of resourceCases) {
      const analyzed = analyzeRepo(item.repo, { ...base.facts, ...item.facts }, { since: 'daily' })
      assert.equal(blockText(analyzed, '上手门槛'), RESOURCE_TEXT, `${item.name} must use the fixed resource sentence`)
    }

    // Word boundaries: "listen"/"notebook" must not match "list"/"notes".
    const control = analyzeRepo(
      { ...base.repo, name: 'listen-app', fullName: 'acme/listen-app', description: 'A realtime audio listener for the terminal.' },
      { ...base.facts, topics: ['audio'] },
      { since: 'daily' },
    )
    const controlText = blockText(control, '上手门槛')
    assert.ok(controlText.startsWith('需要先会：'), `listen-app must stay a runnable project, got: ${controlText}`)
    assert.ok(!controlText.includes('学术资源'), 'listen-app must not be classified as a resource')

    const notebook = analyzeRepo(
      { ...base.repo, name: 'notebook-ui', fullName: 'acme/notebook-ui', description: 'A notebook style editor.' },
      { ...base.facts, topics: [] },
      { since: 'daily' },
    )
    assert.ok(
      !blockText(notebook, '上手门槛').includes('学术资源'),
      'notebook must not match the "notes" keyword',
    )
  })

  await test('README detection tries the fixed candidate list and reads the three fixtures', async () => {
    assert.deepEqual(README_CANDIDATES, ['README.zh-CN.md', 'README_CN.md', 'README.zh.md', 'README-zh.md', 'README.md'])
    const cases = Array.isArray(fixture.readme) ? fixture.readme : []
    assert.equal(cases.length, 3, 'fixture needs the three README cases')

    for (const item of cases) {
      clearEnrichCache()
      const body = await readFile(path.resolve(rootDir, 'test/fixtures/readme', item.fileName), 'utf8')
      const { fetcher, readmeCalls } = makeFetcher({ readme: new Map([[`${item.fullName}|${item.requestPath}`, body]]) })
      const repo = {
        rank: 1,
        owner: item.fullName.split('/')[0],
        name: item.fullName.split('/')[1],
        fullName: item.fullName,
        url: `https://github.com/${item.fullName}`,
        description: 'README fixture repository.',
        language: null,
        languageColor: null,
        stars: 10,
        forks: 1,
        delta: 1,
        contributors: [],
      }
      const result = await enrichRepos([repo], { enrichCount: 1, readmeCount: 1, fetcher })
      const facts = result.facts.get(item.fullName)
      assert.ok(facts, `${item.name}: missing facts`)
      assert.equal(facts.readmeZh, item.expectedZh, `${item.name}: readmeZh`)
      assert.equal(facts.readmePath, item.expectedPath, `${item.name}: readmePath`)
      assert.ok(facts.readmeSnippet && facts.readmeSnippet.length > 0, `${item.name}: readmeSnippet`)
      const attemptedPaths = readmeCalls.map((url) => {
        const match = /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/(?:HEAD|main|master)\/(.+)$/.exec(url)
        assert.ok(match, `${item.name}: unexpected README URL ${url}`)
        return match[1]
      })
      assert.ok(attemptedPaths.includes(item.requestPath), `${item.name}: expected path was not tried`)
      for (const attempted of attemptedPaths) {
        assert.ok(README_CANDIDATES.includes(attempted), `${item.name}: unexpected candidate ${attempted}`)
      }
    }
  })

  await test('raw README channel still works when the GitHub API quota is exhausted', async () => {
    clearEnrichCache()
    const body = '# 中文说明\n\n这是一个中文 README 正文，API 配额耗尽时仍然必须能读到。'
    const fullName = 'acme/quota-free'
    const { fetcher, apiReadmeCalls, readmeTimeouts } = makeFetcher({
      apiStatus: 403,
      readme: new Map([[`${fullName}|README.zh-CN.md`, body]]),
    })
    const result = await enrichRepos([readmeRepo(fullName)], { enrichCount: 1, readmeCount: 1, fetcher })
    const facts = result.facts.get(fullName)
    assert.ok(facts, 'facts missing')
    assert.equal(facts.enriched, false, 'metadata must degrade when the API is rate limited')
    assert.match(String(facts.note), /rate limit/i)
    assert.equal(facts.readmeZh, true, 'readmeZh must come from the Chinese file name')
    assert.equal(facts.readmePath, 'README.zh-CN.md')
    assert.ok(facts.readmeSnippet && facts.readmeSnippet.includes('中文 README'), 'readmeSnippet must be filled from raw')
    assert.equal(apiReadmeCalls.length, 0, 'the API contents fallback must not run after a 403')
    assert.ok(readmeTimeouts.every((value) => value > 0 && value <= 8000), 'raw timeout must be at most 8000ms')
  })

  await test('raw 404 on every candidate falls back to the API contents channel exactly once', async () => {
    clearEnrichCache()
    const fullName = 'acme/api-fallback'
    const { fetcher, readmeCalls, apiReadmeCalls } = makeFetcher({
      apiReadme: new Map([[fullName, { path: 'README.rst', body: 'API fallback README.\n\nInstall with pip.' }]]),
    })
    const result = await enrichRepos([readmeRepo(fullName)], { enrichCount: 1, readmeCount: 1, fetcher })
    const facts = result.facts.get(fullName)
    assert.equal(readmeCalls.length, 15, 'five candidates on HEAD/main/master must all miss first')
    assert.equal(apiReadmeCalls.length, 1, 'the API contents channel must be called exactly once')
    assert.equal(facts.readmePath, 'README.rst', 'the API channel supplies the real path')
    assert.equal(facts.readmeZh, false, 'README.rst with English text must not be flagged Chinese')
    assert.ok(facts.readmeSnippet && facts.readmeSnippet.includes('API fallback'), 'snippet must come from the API fallback')
  })

  await test('raw channel timeout degrades to no README and never throws', async () => {
    clearEnrichCache()
    const fullName = 'acme/raw-timeout'
    const { fetcher, readmeTimeouts } = makeFetcher({
      rawError: new Error('The operation was aborted due to timeout'),
      apiReadme: new Map(),
    })
    const result = await enrichRepos([readmeRepo(fullName)], { enrichCount: 1, readmeCount: 1, fetcher })
    const facts = result.facts.get(fullName)
    assert.ok(facts, 'a timeout must still return facts')
    assert.equal(facts.readmeSnippet, null, 'no snippet when both channels miss')
    assert.equal(facts.readmePath, null)
    assert.equal(facts.enriched, true, 'metadata enrichment is unaffected by the raw timeout')
    assert.ok(readmeTimeouts.length >= 5, 'every candidate must be attempted')
    assert.ok(readmeTimeouts.every((value) => value > 0 && value <= 8000), 'raw timeout must be at most 8000ms')
  })

  await test('raw channel probes main/master when HEAD has no README', async () => {
    clearEnrichCache()
    const fullName = 'acme/ref-fallback'
    const body = '# Ref fallback\n\nHEAD is not the default branch here.'
    const { fetcher, readmeCalls } = makeFetcher({
      readme: new Map([[`${fullName}|main|README.md`, body]]),
    })
    const result = await enrichRepos([readmeRepo(fullName)], { enrichCount: 1, readmeCount: 1, fetcher, budgetMs: 20000 })
    const facts = result.facts.get(fullName)
    assert.ok(facts.readmeSnippet && facts.readmeSnippet.includes('Ref fallback'))
    assert.ok(readmeCalls.some((url) => url.includes(`/${fullName}/main/README.md`)), 'main must be probed after HEAD misses')
  })

  await test('analyzeRepo passes facts.readmeZh/readmePath through to the analyzed card', () => {
    const card = cards[0]
    const base = { ...card.facts }
    const zh = analyzeRepo(card.repo, { ...base, readmeZh: true, readmePath: 'README.zh-CN.md' }, { since: 'daily' })
    assert.equal(zh.readmeZh, true, 'analyzeRepo must expose readmeZh=true for the client badge')
    assert.equal(zh.readmePath, 'README.zh-CN.md')

    const en = analyzeRepo(card.repo, { ...base, readmeZh: false, readmePath: 'README.md' }, { since: 'daily' })
    assert.equal(en.readmeZh, false)
    assert.equal(en.readmePath, 'README.md')

    const missing = analyzeRepo(card.repo, { ...base, readmeZh: undefined, readmePath: undefined }, { since: 'daily' })
    assert.equal(missing.readmeZh, false, 'undefined readmeZh must become false')
    assert.equal(missing.readmePath, null)
  })

  await test('enrichRepos only calls the API for the first N repositories', async () => {
    const enrichment = fixture.enrichment ?? {}
    const repos = enrichment.repos ?? []
    assert.equal(repos.length, 11, 'fixture needs eleven budget repositories')
    clearEnrichCache()
    const { fetcher, apiCalls } = makeFetcher()
    const result = await enrichRepos(repos, {
      enrichCount: enrichment.enrichCount ?? 10,
      readmeCount: enrichment.readmeCount ?? 0,
      fetcher,
    })

    assert.equal(result.apiCalls, 10, 'exactly ten API calls for enrichCount=10')
    assert.equal(apiCalls.length, 10, 'the fake transport must see ten API calls')
    assert.equal(result.facts.size, 11, 'every repository still gets a facts entry')
    assert.equal(result.enrichedCount, 10, 'enrichedCount counts facts.enriched===true')
    let counted = 0
    for (const facts of result.facts.values()) if (facts.enriched === true) counted += 1
    assert.equal(result.enrichedCount, counted)
    assert.ok(!apiCalls.some((url) => url.endsWith('/budget/repo-11')), 'the 11th repository must not hit the API')
    assert.equal(result.facts.get('budget/repo-01').enriched, true)
    assert.equal(result.facts.get('budget/repo-11').enriched, false)
    assert.equal(result.facts.get('budget/repo-11').note, 'not enriched (budget)')
  })

  await test('enrichCount=0 makes zero API calls and marks every repository as budget', async () => {
    const repos = fixture.enrichment?.repos ?? []
    clearEnrichCache()
    const { fetcher, apiCalls } = makeFetcher()
    const result = await enrichRepos(repos, { enrichCount: 0, readmeCount: 0, fetcher })
    assert.equal(result.apiCalls, 0)
    assert.equal(apiCalls.length, 0)
    assert.equal(result.facts.size, 11)
    assert.equal(result.enrichedCount, 0)
    for (const facts of result.facts.values()) {
      assert.equal(facts.enriched, false)
      assert.equal(facts.note, 'not enriched (budget)')
    }
  })

  await test('report carries enrichedCount and the accumulated apiCalls counter', async () => {
    clearReportCache()
    const report = await getReport({
      since: 'daily',
      limit: 3,
      refresh: true,
      enrichCount: 0,
      readmeCount: 0,
      fetchBoard: async () => ({ repos: cards.map((card) => card.repo), via: 'direct' }),
    })
    assert.equal(report.repos.length, 3)
    assert.equal(report.enrichedCount, 0)
    assert.equal(report.apiCalls, 0)
  })

  await test('English descriptions produce a Chinese-only 项目介绍', () => {
    for (const card of cards) {
      const text = blockText(analyze(card), '项目介绍')
      assert.ok(hasCjk(text), `${card.name}: 项目介绍 must be Chinese, got: ${text}`)
      const leftovers = leftoverLatin(text, card.repo).match(/[A-Za-z]{3,}/g) ?? []
      assert.deepEqual(leftovers, [], `${card.name}: 项目介绍 still has English words: ${text}`)
    }
  })

  await test('Chinese descriptions are quoted verbatim in 项目介绍', () => {
    const base = cards[0]
    const description = '一个用于在多个大模型之间转发提示词的开源网关，支持流式响应与用量统计。'
    const repo = { ...base.repo, name: 'model-router-zh', fullName: 'acme/model-router-zh', description }
    const analyzed = analyzeRepo(repo, base.facts, { since: 'daily' })
    const text = blockText(analyzed, '项目介绍')
    assert.ok(text.includes(description), `中文原文 must be kept, got: ${text}`)
  })

  await test('English-only descriptions with empty topics still produce distinct Chinese 项目介绍', () => {
    const base = cards[0]
    const cases = [
      { name: 'audit-browser', description: 'Browser automation and audit workflows for security teams.' },
      { name: 'terminal-editor', description: 'A terminal editor with plugin support for coding.' },
    ]
    const rendered = cases.map((item) => {
      const repo = { ...base.repo, name: item.name, fullName: `acme/${item.name}`, description: item.description }
      const analyzed = analyzeRepo(repo, { ...base.facts, topics: [] }, { since: 'daily' })
      return { repo, text: blockText(analyzed, '项目介绍') }
    })
    assert.notEqual(
      rendered[0].text,
      rendered[1].text,
      `description terms must differentiate the two cards, both rendered: ${rendered.map((item) => item.text).join(' / ')}`,
    )
    for (const item of rendered) {
      const leftovers = leftoverLatin(item.text, item.repo).match(/[A-Za-z]{3,}/g) ?? []
      assert.deepEqual(leftovers, [], `${item.repo.name}: 项目介绍 still has English words: ${item.text}`)
    }
  })

  await test('TOPIC_GLOSSARY has at least 120 entries', () => {
    assert.ok(
      Object.keys(TOPIC_GLOSSARY).length >= 120,
      `glossary needs 120 entries, has ${Object.keys(TOPIC_GLOSSARY).length}`,
    )
  })
} finally {
  globalThis.fetch = realFetch

  const failed = outcomes.filter((outcome) => !outcome.ok)
  console.log('')
  console.log(`${outcomes.length - failed.length}/${outcomes.length} tests passed`)
  if (failed.length > 0) process.exitCode = 1
}
