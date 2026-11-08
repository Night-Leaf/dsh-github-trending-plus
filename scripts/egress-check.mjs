#!/usr/bin/env node
/**
 * 现场出网诊断：只调用插件自己的 getReport()，逐次打印一行 JSON。
 *
 * 用途：
 *   在真实机器上确认「插件当前能不能取到 GitHub Trending」，以及走的是哪条
 *   出网路径（system-proxy / local-proxy-* / local-mitm / direct / doh-ip）。
 *   诊断对象是插件自己的传输链，不是另写一套 HTTP 请求。
 *
 * 用法：
 *   node build.mjs
 *   node scripts/egress-check.mjs [--runs=N] [--max-ms=N] [--mode=auto|direct] [--installed]
 *
 * 参数：
 *   --runs=N       连续取数次数，默认 1
 *   --max-ms=N     单次耗时上限（毫秒），默认 25000；超过即记为失败
 *   --mode=auto    插件默认选路：系统代理 / 本机代理端口 / 本机 MITM / 直连 / DoH
 *   --mode=direct  强制直连：只调 configureNetwork({ forceDirect: true })，用于判断
 *                  本机能否直接访问 GitHub；不会关闭用户的代理软件或系统代理
 *   --installed    改从已安装副本导入
 *                  <DSH profile>/node_modules/dsh-github-trending-plus/lib/report.js
 *                  （路径用 --installed-root=<path> 或环境变量 DSH_GITHUB_TRENDING_INSTALLED 指定）
 *
 * 输出与退出码：
 *   每次调用打印一行 JSON：{run, via, repos, ms, error}
 *   全部成功（repos >= 1 且未超时）退出 0，否则退出 1。
 *
 * 取数规模：daily 前 15 条，不做 enrichment / README 抓取，也不读缓存
 * （refresh: true），目的是尽快把「出网是否通」暴露出来。
 *
 * 本脚本只读：不改注册表、不改系统代理、不装证书、不起本地代理、不写任何系统设置。
 * 先由调用方负责 `node build.mjs`；本脚本只 import 构建产物 lib/report.js。
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { getReport as localGetReport } from '../lib/report.js'
import { configureNetwork as localConfigureNetwork } from '../lib/http.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LOCAL_ROOT = path.resolve(HERE, '..')
/** Installed copy to probe with --installed: flag first, then env, then DSH_HOME. */
function resolveInstalledRoot(explicit) {
  if (explicit) return explicit
  if (process.env.DSH_GITHUB_TRENDING_INSTALLED) return process.env.DSH_GITHUB_TRENDING_INSTALLED
  if (process.env.DSH_HOME) {
    return path.join(process.env.DSH_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-github-trending-plus')
  }
  return ''
}

const REPORT_OPTIONS = Object.freeze({
  since: 'daily',
  limit: 15,
  focusCount: 1,
  enrichCount: 0,
  readmeCount: 0,
  refresh: true,
})

const DEFAULTS = Object.freeze({ runs: 1, maxMs: 25000, mode: 'auto', installed: false, installedRoot: '' })

/** Parse `--name=value` / `--name value`; flags such as `--installed` take no value. */
function parseArgs(argv) {
  const options = { ...DEFAULTS }
  for (let index = 0; index < argv.length; index += 1) {
    const match = /^--([a-z][a-z-]*)(?:=(.*))?$/.exec(argv[index])
    if (!match) return { error: `无法识别的参数：${argv[index]}` }
    const name = match[1]
    const inline = match[2]
    const takeValue = () => {
      if (inline !== undefined) return inline
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) return undefined
      index += 1
      return next
    }
    if (name === 'installed') {
      options.installed = true
      continue
    }
    if (name === 'installed-root') {
      const dir = takeValue()
      if (!dir) return { error: '--installed-root 需要目录路径' }
      options.installedRoot = dir
      continue
    }
    const value = takeValue()
    if (name === 'runs' || name === 'max-ms') {
      const number = Number(value)
      if (!Number.isInteger(number) || number < 1) {
        return { error: `--${name} 需要正整数，收到：${value === undefined ? '(缺失)' : value}` }
      }
      if (name === 'runs') options.runs = number
      else options.maxMs = number
      continue
    }
    if (name === 'mode') {
      if (value !== 'auto' && value !== 'direct') {
        return { error: `--mode 只能是 auto 或 direct，收到：${value === undefined ? '(缺失)' : value}` }
      }
      options.mode = value
      continue
    }
    return { error: `未知参数：--${name}` }
  }
  return { options }
}

async function loadInstalledModules(root) {
  const reportModule = await import(pathToFileURL(path.join(root, 'lib', 'report.js')).href)
  const httpModule = await import(pathToFileURL(path.join(root, 'lib', 'http.js')).href)
  return { getReport: reportModule.getReport, configureNetwork: httpModule.configureNetwork }
}

/** One diagnostic call; returns the printed record and whether it counts as success. */
async function runOnce(run, getReport, maxMs) {
  const started = Date.now()
  let report = null
  let error = null
  try {
    report = await getReport({ ...REPORT_OPTIONS })
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown)
  }
  const ms = Date.now() - started
  const repos = Array.isArray(report?.repos) ? report.repos.length : 0
  const via = String(report?.lastVia ?? '')
  if (!error) {
    if (report?.error) {
      error = String(report.error.detail ?? 'report returned error')
    } else if (repos < 1) {
      error = 'empty report (0 repos)'
    } else if (ms > maxMs) {
      error = `over --max-ms (${ms}ms > ${maxMs}ms)`
    }
  }
  return { record: { run, via, repos, ms, error }, ok: repos >= 1 && error === null }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.error) {
    console.error(`egress-check: ${parsed.error}`)
    process.exitCode = 1
    return
  }
  const { runs, maxMs, mode, installed, installedRoot } = parsed.options

  let getReport = localGetReport
  let configureNetwork = localConfigureNetwork
  if (installed) {
    const root = resolveInstalledRoot(installedRoot)
    if (!root) {
      console.error(
        'egress-check: --installed 需要知道已安装副本的位置，用 --installed-root=<path> 或环境变量 DSH_GITHUB_TRENDING_INSTALLED（或 DSH_HOME）指定',
      )
      process.exitCode = 1
      return
    }
    try {
      const modules = await loadInstalledModules(root)
      getReport = modules.getReport
      configureNetwork = modules.configureNetwork
    } catch (error) {
      console.error(
        `egress-check: 无法从 ${root} 导入：${error instanceof Error ? error.message : String(error)}`,
      )
      process.exitCode = 1
      return
    }
  }
  if (typeof getReport !== 'function' || typeof configureNetwork !== 'function') {
    console.error('egress-check: 构建产物缺少 getReport() 或 configureNetwork()，先运行 node build.mjs')
    process.exitCode = 1
    return
  }

  // Defaults come from configureNetwork({}) exactly like the offline test stubs;
  // direct mode only flips forceDirect and never touches system settings.
  configureNetwork(mode === 'direct' ? { forceDirect: true } : {})

  let failures = 0
  for (let run = 1; run <= runs; run += 1) {
    const { record, ok } = await runOnce(run, getReport, maxMs)
    console.log(JSON.stringify(record))
    if (!ok) failures += 1
  }
  process.exitCode = failures === 0 ? 0 : 1
}

await main()
