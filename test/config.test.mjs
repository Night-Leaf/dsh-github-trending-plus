#!/usr/bin/env node
/**
 * Offline acceptance checks for Task-9: package coordinates, module id,
 * Cordis loader config, bilingual README, LICENSE fork notice, locale meta and
 * the absence of personal keywords in source and docs.
 *
 * No network, no host, no build: run it after `node build.mjs`.
 *
 * Usage: node test/config.test.mjs
 */

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(here, '..')

const PACKAGE_NAME = 'dsh-github-trending-plus'
const VERSION = '2.0.0'
const NODE_RANGE = '>=22.13'
const RELEASE_URL = 'https://github.com/Night-Leaf/dsh-github-trending-plus'
const FORK_URL = 'https://github.com/Royalsan/dsh-github-trending'
const PERSONAL_WORDS = ['学习通', '考研', 'dsh-github-trending-plus-xxx']
// Built at runtime so this file itself never contains the forbidden literal.
const PLACEHOLDER = ['OWNER', 'PENDING'].join('-')

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

const read = (relative) => readFile(path.join(rootDir, relative), 'utf8')
const readJson = async (relative) => JSON.parse(await read(relative))

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await walk(full)))
    else if (entry.isFile()) files.push(full)
  }
  return files
}

await test('package.json carries the plus name, 2.0.0 and Node >=22.13', async () => {
  const pkg = await readJson('package.json')
  assert.equal(pkg.name, PACKAGE_NAME)
  assert.equal(pkg.version, VERSION)
  assert.equal(pkg.engines.node, NODE_RANGE)
  assert.equal(pkg.license, 'MIT')
  assert.ok(!JSON.stringify(pkg).includes('@royalsan'), 'package.json must not reference the old scope')
})

await test('release coordinates point at the Night-Leaf repository', async () => {
  const pkg = await readJson('package.json')
  assert.equal(pkg.repository.url, RELEASE_URL)
  assert.equal(pkg.homepage, RELEASE_URL)
  assert.equal(pkg.bugs.url, RELEASE_URL)
  const serialized = JSON.stringify(pkg)
  assert.ok(!serialized.includes('<GITHUB_OWNER>'), 'must not leave the old <GITHUB_OWNER> marker')
  assert.ok(!serialized.includes('Royalsan'), 'the coordinates must not point at the upstream account')
})

await test(`repository contains no ${PLACEHOLDER} placeholder`, async () => {
  const rootEntries = await readdir(rootDir, { withFileTypes: true })
  const files = [
    ...(await walk(path.join(rootDir, 'src'))),
    ...(await walk(path.join(rootDir, 'test'))),
    ...rootEntries
      .filter((entry) => entry.isFile() && (entry.name.endsWith('.md') || /^cordis.*\.yml$/.test(entry.name)))
      .map((entry) => path.join(rootDir, entry.name)),
    path.join(rootDir, 'package.json'),
  ]
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    assert.ok(!text.includes(PLACEHOLDER), `${path.relative(rootDir, file)} still contains the release placeholder`)
  }
})

await test('client module id is dsh-github-trending-plus while BASE/NS stay stable', async () => {
  const source = await read('src/client.ts')
  assert.match(source, /id:\s*'dsh-github-trending-plus'/)
  assert.match(source, /const NS = 'dsh-github-trending'/)
  assert.match(source, /const BASE = '\/dsh-github-trending'/)
  assert.ok(!source.includes("id: '@royalsan/dsh-github-trending'"))

  const built = await read('client.js')
  assert.match(built, /id:\s*'dsh-github-trending-plus'/)
  assert.match(built, /const BASE = '\/dsh-github-trending'/)
  assert.match(built, /const NS = 'dsh-github-trending'/)
})

await test('cordis.patch.yml and cordis.yml use the new id/name', async () => {
  const patch = await read('cordis.patch.yml')
  assert.match(patch, /id:\s*dsh-github-trending-plus/)
  assert.match(patch, /name:\s*dsh-github-trending-plus/)
  assert.ok(!patch.includes('@royalsan'))

  const cordis = await read('cordis.yml')
  assert.match(cordis, /id:\s*dsh-github-trending-plus/)
  assert.match(cordis, /name:\s*dsh-github-trending-plus/)
  assert.match(cordis, /defaultLimit:\s*50/)
  assert.doesNotMatch(cordis, /defaultFocus/)
  assert.ok(!cordis.includes('@royalsan'))
})

const CONFIG_FIELDS = [
  'defaultSince',
  'defaultLimit',
  'deepCount',
  'customBoards',
  'networkMode',
  'proxyUrl',
  'dohEndpoints',
  'candidateIPs',
  'installQuality',
  'forceDirect',
  'caPath',
  'totalBudgetMs',
]

await test('README.md documents install channels, config, network, Node and upgrade', async () => {
  const text = await read('README.md')
  assert.ok(text.includes('渠道一：GitHub（推荐）'), 'GitHub is the recommended channel after publishing')
  assert.ok(text.includes('github:Night-Leaf/dsh-github-trending-plus'), 'GitHub channel names the repository')
  assert.ok(text.includes('渠道二：本地路径'), 'Chinese README must name the local-path channel')
  assert.ok(text.includes('渠道三：npm（暂未发布）'), 'npm must be marked as not published yet')
  assert.ok(!text.includes('<GITHUB_OWNER>'))
  assert.ok(text.includes(FORK_URL), 'README must state the upstream fork URL')
  assert.ok(text.includes('22.13'), 'README must state the Node requirement')
  for (const field of CONFIG_FIELDS) assert.ok(text.includes('`' + field + '`'), `config table must list ${field}`)
  assert.ok(text.includes('DoH'))
  assert.ok(text.includes('hosts'), 'README must say hosts edits are not needed')
  assert.ok(text.includes('不需要'), 'README must state no proxy/hosts changes are needed by default')
  assert.ok(text.includes('和原版有什么不一样'), 'README must compare itself with the original')
  assert.ok(text.includes('pnpm remove'), 'upgrade must remove the old package first')
  assert.ok(text.includes('dsh.profile.bundles'))
  assert.ok(text.includes('重启 DSH'))
})

await test('README.en.md mirrors the Chinese README', async () => {
  const text = await read('README.en.md')
  assert.ok(text.includes('Channel 1: GitHub (recommended)'))
  assert.ok(text.includes('github:Night-Leaf/dsh-github-trending-plus'))
  assert.ok(text.includes('Channel 2: Local path'), 'English README must name the local-path channel')
  assert.ok(text.includes('Channel 3: npm (not published yet)'))
  assert.ok(!text.includes('<GITHUB_OWNER>'))
  assert.ok(text.includes(FORK_URL))
  assert.ok(text.includes('22.13'))
  for (const field of CONFIG_FIELDS) assert.ok(text.includes('`' + field + '`'), `config table must list ${field}`)
  assert.ok(text.includes('DoH'))
  assert.ok(text.includes('hosts'))
  assert.ok(text.includes('How it differs from the original'), 'English README must compare itself with the original')
  assert.ok(text.includes('pnpm remove'))
  assert.ok(text.includes('dsh.profile.bundles'))
  assert.ok(text.includes('Restart DSH'))
})

await test('LICENSE keeps the MIT text, original copyright and adds the fork line', async () => {
  const text = await read('LICENSE')
  assert.ok(text.startsWith('MIT License'))
  assert.ok(text.includes('Copyright (c) 2026 yhm <1498660652@qq.com>'))
  assert.ok(text.includes(`Forked from ${FORK_URL}`))
  assert.ok(text.includes('Permission is hereby granted, free of charge'))
})

await test('locale meta mentions 13 boards, the 50 cap and the Chinese README badge', async () => {
  const zh = await readJson('locale/zh.json')
  const en = await readJson('locale/en.json')
  assert.ok(zh.meta.description.includes('13'))
  assert.ok(zh.meta.description.includes('50'))
  assert.ok(zh.meta.description.includes('中文 README'))
  assert.ok(en.meta.description.includes('13'))
  assert.ok(en.meta.description.includes('50'))
  assert.ok(en.meta.description.includes('Chinese README'))
})

await test('source and docs contain no personal keywords', async () => {
  const files = (await walk(path.join(rootDir, 'src'))).concat(
    ['README.md', 'README.en.md', 'LICENSE', 'package.json', 'cordis.patch.yml', 'cordis.yml', 'locale/zh.json', 'locale/en.json'].map(
      (relative) => path.join(rootDir, relative),
    ),
  )
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    for (const word of PERSONAL_WORDS) {
      assert.ok(!text.includes(word), `${path.relative(rootDir, file)} must not contain ${word}`)
    }
  }
})

const failed = outcomes.filter((item) => !item.ok)
console.log('')
console.log(`${outcomes.length - failed.length}/${outcomes.length} checks passed`)
if (failed.length > 0) {
  console.error(`${failed.length} check(s) failed`)
  process.exitCode = 1
}
