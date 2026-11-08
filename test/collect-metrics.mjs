#!/usr/bin/env node
/**
 * Collects one layout-metrics beacon from test/out/*-preview.html opened in a
 * browser (see make-preview.mjs) and prints it. Run this first, then open the
 * preview page or start a headless browser against it.
 */
import { createServer } from 'node:http'

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1:8899')
  if (url.pathname !== '/beacon') {
    response.writeHead(404).end()
    return
  }
  response.writeHead(200, { 'content-type': 'image/gif', 'access-control-allow-origin': '*' }).end()
  const raw = url.searchParams.get('d') ?? ''
  try {
    console.log(JSON.stringify(JSON.parse(raw), null, 2))
  } catch (error) {
    console.log('parse error:', String(error), raw.slice(0, 200))
  }
  server.close(() => process.exit(0))
})

server.listen(8899, '127.0.0.1', () => console.log('collector listening on 127.0.0.1:8899'))
setTimeout(() => {
  console.error('timed out')
  process.exit(1)
}, 60000).unref()