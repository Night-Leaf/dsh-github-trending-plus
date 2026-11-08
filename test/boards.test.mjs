#!/usr/bin/env node
/**
 * Offline tests for the Task-2 data source.
 *
 * Not a single request leaves this machine: both boards are fixture-backed
 * fakes passed through `fetchBoard`, enrichment is switched off with
 * `enrichCount: 0`, and a global fetch spy fails the run if anything tries the
 * real transport. Run with:
 *
 *   node build.mjs && node test/boards.test.mjs --fixtures test/fixtures/trending
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { POPULAR_LANGUAGES, fetchTrendingSet, parseTrendingHtml } from '../lib/trending.js'
import { githubToken } from '../lib/enrich.js'
import { clearReportCache, getReport, reportQuery } from '../lib/report.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(here, '..')

function argumentValue(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  return fallback
}

const fixtureDir = path.resolve(rootDir, argumentValue('--fixtures', 'test/fixtures/trending'))

async function readJson(name) {
  return JSON.parse(await readFile(path.join(fixtureDir, name), 'utf8'))
}

async function readText(name) {
  return readFile(path.join(fixtureDir, name), 'utf8')
}

// Guard rail: the whole file must stay offline. Any direct `fetch` attempt is a
// test failure, not a slow network timeout.
const realFetch = globalThis.fetch
let networkAttempts = 0
globalThis.fetch = async () => {
  networkAttempts += 1
  throw new Error('boards.test.mjs must not touch the network')
}

const outcomes = []
let languageBoard
let popularBoard
let languageHtml

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

function fakeBoards(calls, via = 'direct') {
  return async (options) => {
    calls.push({ since: options.since, language: options.language })
    if (options.language) return { repos: languageBoard, via }
    return { repos: popularBoard, via }
  }
}

/** Minimal repository for synthetic boards; only fullName and rank matter here. */
function syntheticRepo(fullName) {
  const [owner, name] = fullName.split('/')
  return {
    rank: 1,
    owner,
    name,
    fullName,
    url: 'https://github.com/' + fullName,
    description: fullName,
    language: null,
    languageColor: null,
    stars: 1,
    forks: 1,
    delta: 1,
    contributors: [],
  }
}

try {
  languageBoard = await readJson('boards-language.json')
  popularBoard = await readJson('boards-popular.json')
  languageHtml = await readText('language-typescript.html')

  await test('language-typescript.html parses into 12 TypeScript repositories', () => {
    const repos = parseTrendingHtml(languageHtml, 'daily')
    assert.equal(repos.length, 12)
    assert.equal(repos[0].fullName, 'acme/ts-alpha')
    assert.equal(repos[0].language, 'TypeScript')
    assert.equal(repos[0].stars, 1200)
    assert.equal(repos[0].delta, 120)
    assert.equal(repos[11].fullName, 'mu/ts-mu')
    repos.forEach((repo, index) => assert.equal(repo.rank, index + 1))
  })

  await test('TypeScript language board is read first, then the all-language board tops it up', async () => {
    const calls = []
    const set = await fetchTrendingSet({
      since: 'daily',
      language: 'TypeScript',
      target: 50,
      fetchBoard: fakeBoards(calls),
    })
    assert.ok(calls.length >= 2, 'the language board and the all-language board are both read')
    assert.equal(calls[0].since, 'daily')
    assert.equal(calls[0].language, 'typescript')
    assert.equal(calls[1].since, 'daily')
    assert.equal(calls[1].language, null)
    // Every later call is a filler language board; the selected language is not refetched.
    assert.ok(calls.slice(2).every((call) => call.language && call.language !== 'typescript'), 'fillers never repeat the selected language')
    assert.equal(calls[2].language, 'javascript', 'filler boards follow POPULAR_LANGUAGES order')
    assert.equal(set.repos.length, 17)
    assert.equal(set.repos.filter((repo) => repo.source === 'language').length, 12)
    assert.equal(set.repos.filter((repo) => repo.source === 'popular').length, 5)
    assert.equal(set.repos.filter((repo) => repo.source === 'filler').length, 0)
    assert.equal(new Set(set.repos.map((repo) => repo.fullName)).size, 17)
    assert.equal(set.shortfall, 33)
    assert.equal(set.shortfallReason, 'no-more-boards')
    assert.equal(set.lastVia, 'direct')
    set.repos.forEach((repo, index) => assert.equal(repo.rank, index + 1))
  })

  await test('without a language the all-language board is filled up to 50 by other language boards', async () => {
    const calls = []
    const set = await fetchTrendingSet({
      since: 'daily',
      language: '',
      target: 50,
      fetchBoard: async (options) => {
        calls.push({ since: options.since, language: options.language })
        if (!options.language) {
          return { repos: Array.from({ length: 8 }, (_, index) => syntheticRepo('popular/pop-' + index)), via: 'direct' }
        }
        return {
          repos: Array.from({ length: 14 }, (_, index) => syntheticRepo('lang-' + options.language + '/repo-' + index)),
          via: 'direct',
        }
      },
    })
    assert.equal(set.repos.length, 50, 'fillers stop as soon as the target is met')
    assert.equal(set.repos.filter((repo) => repo.source === 'popular').length, 8)
    assert.equal(set.repos.filter((repo) => repo.source === 'filler').length, 42)
    assert.equal(set.repos.filter((repo) => repo.source === 'language').length, 0)
    assert.equal(new Set(set.repos.map((repo) => repo.fullName)).size, 50, 'filler rows are de-duplicated by fullName')
    assert.deepEqual(
      calls.map((call) => call.language),
      [null, 'typescript', 'javascript', 'python'],
      'the all-language board is first, then POPULAR_LANGUAGES in order',
    )
    assert.equal(set.shortfall, 0)
    assert.equal(set.shortfallReason, null)
    set.repos.forEach((repo, index) => assert.equal(repo.rank, index + 1))
  })

  await test('with a language the three sources are language → popular → filler, in that order', async () => {
    const calls = []
    const set = await fetchTrendingSet({
      since: 'daily',
      language: 'TypeScript',
      target: 50,
      fetchBoard: async (options) => {
        calls.push(options.language)
        if (options.language === 'typescript') {
          return { repos: Array.from({ length: 12 }, (_, index) => syntheticRepo('acme/ts-' + index)), via: 'direct' }
        }
        if (options.language === null) {
          const repos = [syntheticRepo('acme/ts-0'), syntheticRepo('acme/ts-1'), syntheticRepo('acme/ts-2')]
          for (let index = 0; index < 5; index += 1) repos.push(syntheticRepo('popular/pop-' + index))
          return { repos, via: 'direct' }
        }
        if (options.language === 'javascript') {
          return { repos: Array.from({ length: 33 }, (_, index) => syntheticRepo('js/js-' + index)), via: 'proxy' }
        }
        return { repos: [], via: '' }
      },
    })
    assert.deepEqual(calls, ['typescript', null, 'javascript'], 'stops once the target is met')
    assert.equal(set.repos.length, 50)
    assert.equal(set.repos.filter((repo) => repo.source === 'language').length, 12)
    assert.equal(set.repos.filter((repo) => repo.source === 'popular').length, 5)
    assert.equal(set.repos.filter((repo) => repo.source === 'filler').length, 33)
    assert.equal(new Set(set.repos.map((repo) => repo.fullName)).size, 50)
    assert.equal(set.shortfall, 0)
    assert.equal(set.lastVia, 'proxy')
    set.repos.forEach((repo, index) => assert.equal(repo.rank, index + 1))
  })

  await test('a target that no board can fill reports the exact shortfall after every board is read', async () => {
    const calls = []
    const languageCount = POPULAR_LANGUAGES.filter((option) => option.slug).length
    const set = await fetchTrendingSet({
      since: 'daily',
      language: '',
      target: 50,
      fetchBoard: async (options) => {
        calls.push(options.language)
        if (!options.language) {
          return { repos: Array.from({ length: 8 }, (_, index) => syntheticRepo('popular/pop-' + index)), via: 'direct' }
        }
        return { repos: [syntheticRepo('solo-' + options.language + '/only-one')], via: 'direct' }
      },
    })
    assert.equal(calls.length, 1 + languageCount, 'the all-language board plus every non-empty language board')
    assert.equal(new Set(calls.slice(1)).size, languageCount, 'each filler language is read exactly once')
    assert.equal(set.repos.length, 8 + languageCount)
    assert.equal(set.shortfall, 50 - (8 + languageCount))
    assert.equal(set.shortfallReason, 'no-more-boards')
  })

  await test('githubToken resolves explicit → GITHUB_TOKEN → GH_TOKEN → file → empty', async () => {
    const keys = ['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN_FILE']
    const saved = {}
    for (const key of keys) saved[key] = process.env[key]
    const dir = await mkdtemp(path.join(tmpdir(), 'github-token-'))
    const file = path.join(dir, 'github-token')
    try {
      process.env.GITHUB_TOKEN_FILE = file
      delete process.env.GITHUB_TOKEN
      delete process.env.GH_TOKEN

      await writeFile(file, '\ufeff  "ghp_from_file"  \n', 'utf8')
      assert.equal(githubToken(''), 'ghp_from_file', 'BOM, whitespace and paired double quotes are removed')
      assert.equal(githubToken('explicit-token'), 'explicit-token', 'the explicit argument wins')

      process.env.GITHUB_TOKEN = 'ghp_env_primary'
      assert.equal(githubToken(''), 'ghp_env_primary', 'GITHUB_TOKEN beats the file')
      process.env.GH_TOKEN = 'ghp_env_secondary'
      delete process.env.GITHUB_TOKEN
      assert.equal(githubToken(''), 'ghp_env_secondary', 'GH_TOKEN is the next fallback')

      await writeFile(file, "'ghp_single_quoted'", 'utf8')
      delete process.env.GH_TOKEN
      assert.equal(githubToken(''), 'ghp_single_quoted', 'paired single quotes are removed too')

      await writeFile(file, '  plain-token\n', 'utf8')
      assert.equal(githubToken(''), 'plain-token', 'the file is trimmed')

      await rm(file)
      assert.equal(githubToken(''), '', 'a missing file degrades to an empty token')
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
      await rm(dir, { recursive: true, force: true })
    }
  })


  await test('a language board that already fills the target is not topped up', async () => {
    const calls = []
    const set = await fetchTrendingSet({
      since: 'daily',
      language: 'typescript',
      target: 10,
      fetchBoard: fakeBoards(calls),
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].language, 'typescript')
    assert.equal(set.shortfall, 0)
    assert.equal(set.shortfallReason, null)
  })

  await test('reportQuery clamps limit to 3-50 with a default of 50', () => {
    assert.equal(reportQuery({}).limit, 50)
    assert.equal(reportQuery({ limit: 100 }).limit, 50)
    assert.equal(reportQuery({ limit: 1 }).limit, 3)
    assert.equal(reportQuery({ limit: 20 }).limit, 20)
    assert.equal(reportQuery({ limit: 'not-a-number' }).limit, 50)
    assert.equal(reportQuery({ limit: 50, focusCount: 1 }).focusCount, 1)
  })

  await test('getReport carries shortfall, apiCalls, lastVia and networkStatus', async () => {
    clearReportCache()
    const calls = []
    const report = await getReport({
      since: 'daily',
      language: 'TypeScript',
      limit: 100,
      focusCount: 3,
      refresh: true,
      enrichCount: 0,
      readmeCount: 0,
      fetchBoard: fakeBoards(calls),
    })
    assert.equal(report.repos.length, 17)
    assert.equal(report.shortfall, 33)
    assert.equal(report.shortfallReason, 'no-more-boards')
    assert.equal(typeof report.apiCalls, 'number')
    assert.equal(report.apiCalls, 0)
    assert.equal(typeof report.lastVia, 'string')
    assert.notEqual(report.lastVia, '')
    assert.equal(report.lastVia, 'direct')
    assert.equal(report.networkStatus, 'direct')
    assert.ok(['direct', 'fallback', 'fail'].includes(report.networkStatus))
    assert.equal(report.repos.filter((repo) => repo.source === 'language').length, 12)
    assert.equal(report.repos.filter((repo) => repo.source === 'popular').length, 5)
    report.repos.forEach((repo, index) => assert.equal(repo.rank, index + 1))
    assert.equal(report.summary.repoCount, 17)
  })

  await test('networkStatus maps a fallback backend to fallback and a missing via to fail', async () => {
    clearReportCache()
    const fallback = await getReport({
      since: 'weekly',
      limit: 50,
      refresh: true,
      enrichCount: 0,
      readmeCount: 0,
      fetchBoard: fakeBoards([], 'proxy'),
    })
    assert.equal(fallback.lastVia, 'proxy')
    assert.equal(fallback.networkStatus, 'fallback')

    const failed = await getReport({
      since: 'monthly',
      limit: 50,
      refresh: true,
      enrichCount: 0,
      readmeCount: 0,
      fetchBoard: fakeBoards([], ''),
    })
    assert.equal(failed.lastVia, '')
    assert.equal(failed.networkStatus, 'fail')
  })
} finally {
  globalThis.fetch = realFetch
}

const failed = outcomes.filter((entry) => !entry.ok)
console.log(`\n${outcomes.length - failed.length}/${outcomes.length} board tests passed`)
if (networkAttempts > 0) {
  console.log(`network guard failed: ${networkAttempts} fetch attempt(s) observed`)
  process.exitCode = 1
} else if (failed.length > 0) {
  console.log(`failed: ${failed.map((entry) => entry.name).join(', ')}`)
  process.exitCode = 1
}
