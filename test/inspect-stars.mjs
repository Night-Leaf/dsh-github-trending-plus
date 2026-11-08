const html = await (await fetch('https://github.com/trending?since=daily', {
  headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' },
})).text()

const chunks = html.split(/<article\b[^>]*class="[^"]*\bBox-row\b/i).slice(1)
const first = chunks[0].slice(0, chunks[0].indexOf('</article>'))

function stripTags(input) {
  return input.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

let index = first.indexOf('/stargazers"')
let count = 0
while (index >= 0 && count < 4) {
  const end = first.indexOf('</a>', index)
  console.log(`--- occurrence ${count} at ${index} ---`)
  console.log(JSON.stringify(stripTags(first.slice(index, end)).slice(0, 120)))
  index = first.indexOf('/stargazers"', index + 1)
  count += 1
}