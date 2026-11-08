import { readFileSync } from 'node:fs'

const file = process.argv[2] || 'test/out/panel-daily.html'
const html = readFileSync(file, 'utf8')
const blocks = [...html.matchAll(/<div class="gt-block">([\s\S]*?)<\/div><\/div><\/article>/g)]
const plain = (value) => value.replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()

console.log('cards with inline analysis:', blocks.length)
if (blocks[0]) console.log(plain(blocks[0][1]).slice(0, 900))