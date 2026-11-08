import { readFileSync } from 'node:fs'

const file = process.argv[2] || 'test/out/panel-daily-preview.html'
const html = readFileSync(file, 'utf8')
const spans = [...html.matchAll(/<span class="gt-note">([^<]*)</g)].map((m) => m[1])
const paras = [...html.matchAll(/<p class="gt-note"[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim())

console.log('span.gt-note:', JSON.stringify(spans))
console.log('p.gt-note:', JSON.stringify(paras))
console.log('tail:', html.slice(-260).replace(/\s+/g, ' '))