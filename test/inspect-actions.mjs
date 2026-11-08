import { readFileSync } from 'node:fs'

const file = process.argv[2] || 'test/out/panel-daily-preview.html'
const html = readFileSync(file, 'utf8')
const patterns = ['导出 Markdown', 'Export Markdown', '/dsh-github-trending/export', '刷新', 'Refresh', 'gt-btn']
for (const pattern of patterns) {
  const count = html.split(pattern).length - 1
  console.log(`${pattern} => ${count}`)
}
const header = html.match(/<div class="gt-actions">[\s\S]{0,400}?<\/div>/)
console.log('actions:', header ? header[0].replace(/\s+/g, ' ').slice(0, 320) : 'none')