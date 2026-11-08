#!/usr/bin/env node
/**
 * Builds a standalone preview of the panel markup captured by smoke-client.mjs.
 *
 * The panel styles only reference `--dsw-alias-*` theme tokens, which the Harness
 * shell injects at runtime. For an offline preview we declare the light and dark
 * values here so the page renders without the shell.
 *
 * Usage: node test/make-preview.mjs [daily|weekly|monthly] [language]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const since = process.argv[2] ?? 'daily'
const language = process.argv[3] ?? ''
const name = ['panel', since, language].filter(Boolean).join('-')
const source = resolve(here, 'out', `${name}.html`)
const target = resolve(here, 'out', `${name}-preview.html`)

const markup = readFileSync(source, 'utf8')

const tokens = `
  :root {
    --dsw-alias-bg-base: #fbfbfd;
    --dsw-alias-bg-layer-1: #ffffff;
    --dsw-alias-bg-layer-2: #f2f3f7;
    --dsw-alias-bg-overlay: #ffffff;
    --dsw-alias-border-l1: #e3e5ec;
    --dsw-alias-border-l2: #d3d6e0;
    --dsw-alias-brand-primary: #4b6bfb;
    --dsw-alias-label-primary: #171922;
    --dsw-alias-label-secondary: #6b7080;
    --dsw-alias-state-error-primary: #d93b3b;
    --dsw-alias-state-idle-primary: #9aa0b0;
    --dsw-alias-state-success-primary: #1f9d55;
    --dsw-alias-state-warn-primary: #d98324;
    --dsw-specific-sidebar-fill: #f5f6fa;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --dsw-alias-bg-base: #12131a;
      --dsw-alias-bg-layer-1: #1a1c25;
      --dsw-alias-bg-layer-2: #23262f;
      --dsw-alias-bg-overlay: #1a1c25;
      --dsw-alias-border-l1: #2c303c;
      --dsw-alias-border-l2: #3a3f4d;
      --dsw-alias-brand-primary: #7d93ff;
      --dsw-alias-label-primary: #eef0f6;
      --dsw-alias-label-secondary: #9aa0b3;
      --dsw-alias-state-error-primary: #ff7a7a;
      --dsw-alias-state-idle-primary: #6b7080;
      --dsw-alias-state-success-primary: #4ad07f;
      --dsw-alias-state-warn-primary: #f0b357;
      --dsw-specific-sidebar-fill: #171922;
    }
  }
  html, body { margin: 0; padding: 0; background: var(--dsw-alias-bg-base); }
`

const metrics = `
  // Layout self-check: writes a JSON snapshot a headless browser can dump.
  window.addEventListener('load', function () {
    const out = {}
    const width = window.innerWidth
    const root = document.querySelector('.gt-root') || document.body
    out.viewport = width
    out.overflowX = Math.max(document.documentElement.scrollWidth, root.scrollWidth) > width + 1
    out.repoCards = document.querySelectorAll('.gt-repo').length
    out.barRows = document.querySelectorAll('.gt-bar-row').length
    out.avatarBoxes = Array.from(document.querySelectorAll('.gt-avatar')).slice(0, 3).map(function (node) {
      const r = node.getBoundingClientRect()
      return Math.round(r.width) + 'x' + Math.round(r.height)
    })
    const tops = Array.from(document.querySelectorAll('.gt-repo')).slice(0, 3).map(function (node) {
      return Math.round(node.getBoundingClientRect().top)
    })
    out.cardsPerRow = tops.length / new Set(tops).size
    out.textWidth = Math.round(root.getBoundingClientRect().width)
    out.pageHeight = Math.round(Math.max(root.scrollHeight, document.body.scrollHeight))
    out.offenders = Array.from(document.querySelectorAll('.gt-root *'))
      .filter(function (node) { return node.getBoundingClientRect().right > width + 1 })
      .slice(0, 6)
      .map(function (node) {
        const text = (node.textContent || '').replace(new RegExp('\\\\s+', 'g'), ' ').slice(0, 60)
        return (node.tagName + '.' + (node.className || '-')) + ' w=' + Math.round(node.getBoundingClientRect().width) + ' ' + text
      })
    const chain = []
    let walker = document.querySelector('.gt-pre')
    while (walker && chain.length < 7) {
      const rect = walker.getBoundingClientRect()
      chain.push((walker.className || walker.tagName) + ' w=' + Math.round(rect.width) + ' sw=' + walker.scrollWidth)
      walker = walker.parentElement
    }
    out.preChain = chain
    const worst = Array.from(document.querySelectorAll('.gt-root *'))
      .filter(function (node) { return node.getBoundingClientRect().right > width + 1 })
      .pop()
    out.worst = worst
      ? [worst.tagName + '.' + (worst.className || '-') + ' w=' + Math.round(worst.getBoundingClientRect().width), worst.outerHTML.slice(0, 220)]
          .concat(
            (function () {
              const line = []
              let node = worst.parentElement
              while (node && line.length < 5) {
                line.push(node.tagName + '.' + (node.className || '-') + ' w=' + Math.round(node.getBoundingClientRect().width) + ' sw=' + node.scrollWidth)
                node = node.parentElement
              }
              return line
            })(),
          )
      : []
    out.text = root.innerText.replace(new RegExp('\\\\s+', 'g'), ' ').slice(0, 500)
    const pre = document.createElement('pre')
    pre.id = 'gt-metrics'
    pre.textContent = JSON.stringify(out)
    document.body.appendChild(pre)
    // Beacon for test/measure-panel.mjs: a headless browser cannot hand its
    // metrics back over stdout in this sandbox, so it pings a local collector.
    try {
      const probe = new Image()
      probe.src = 'http://127.0.0.1:8899/beacon?d=' + encodeURIComponent(JSON.stringify(out))
    } catch (error) {
      /* collector not running: preview still works */
    }
  })
`

writeFileSync(
  target,
  `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GitHub Trending panel preview</title>
<style>${tokens}</style>
</head>
<body>
${markup}
<script>${metrics}</script>
</body>
</html>
`,
)

console.log(`preview written: ${target}`)