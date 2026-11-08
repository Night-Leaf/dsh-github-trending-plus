const html = await (await fetch('https://github.com/trending?since=daily', {
  headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' },
})).text()

console.log('bytes:', html.length)
console.log('article tags:', (html.match(/<article\b/g) || []).length)
console.log('Box-row class occurrences:', (html.match(/Box-row/g) || []).length)

const chunks = html.split(/<article\b[^>]*class="[^"]*\bBox-row\b/i).slice(1)
console.log('chunks:', chunks.length)

const first = chunks[0].slice(0, chunks[0].indexOf('</article>'))
const gi = first.indexOf('stargazers')
console.log('--- stargazers context ---')
console.log(JSON.stringify(first.slice(gi - 140, gi + 340)))
const fi = first.indexOf('/forks')
console.log('--- forks context ---')
console.log(JSON.stringify(first.slice(fi - 80, fi + 300)))
const h2 = first.indexOf('<h2')
console.log('--- h2 context ---')
console.log(JSON.stringify(first.slice(h2, h2 + 420)))

let noLink = 0
for (const chunk of chunks) {
  const body = chunk.slice(0, chunk.indexOf('</article>'))
  if (!/href="\/[A-Za-z0-9][^"]*\/[A-Za-z0-9][^"]*"/.test(body)) noLink += 1
}
console.log('chunks without any repo-ish href:', noLink)