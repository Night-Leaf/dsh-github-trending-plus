#!/usr/bin/env node
/**
 * Renders the standalone panel preview in headless Chrome and reports layout
 * metrics collected by the page itself (see make-preview.mjs).
 *
 * The sandboxed host cannot pipe a browser's stdout, so the page beacons its
 * measurements to a tiny local collector instead.
 *
 * Usage: node test/measure-panel.mjs [daily|weekly|monthly] [language]
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const since = process.argv[2] ?? 'daily'
const language = process.argv[3] ?? ''
const name = ['panel', since, language].filter(Boolean).join('-')
const preview = resolve(here, 'out', `${name}-preview.html`)

if (!existsSync(preview)) {
  console.error(`missing preview: ${preview}\nrun: node test/make-preview.mjs ${since} ${language}`.trim())
  process.exit(1)
}

const candidates = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]
const browser = candidates.find((candidate) => existsSync(candidate))
if (!browser) {
  console.error('no Chrome or Edge found')
  process.exit(1)
}

let settled = false
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1:8899')
  if (url.pathname !== '/beacon') {
    response.writeHead(404).end()
    return
  }
  const raw = url.searchParams.get('d') ?? ''
  response.writeHead(200, { 'content-type': 'image/gif' }).end()
  if (settled) return
  settled = true
  let metrics
  try {
    metrics = JSON.parse(raw)
  } catch (error) {
    metrics = { parseError: String(error), raw }
  }
  console.log(JSON.stringify(metrics, null, 2))
  shutdown(0)
})

const child = spawn(
  browser,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-crash-reporter',
    '--disable-breakpad',
    `--user-data-dir=${resolve(here, 'out', 'chrome-profile')}`,
    '--window-size=1280,2400',
    '--hide-scrollbars',
    preview.startsWith('file:') ? preview : `file:///${preview.replace(/\\/g, '/')}`,
  ],
  { stdio: 'ignore' },
)

function shutdown(code) {
  if (child.exitCode === null) child.kill()
  server.close(() => process.exit(code))
}

server.listen(8899, '127.0.0.1', () => {
  setTimeout(() => {
    if (settled) return
    console.error('timed out waiting for the page beacon')
    shutdown(1)
  }, 45000).unref()
})