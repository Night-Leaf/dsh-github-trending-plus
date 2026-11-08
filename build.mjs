/**
 * Build: strip TypeScript types (no bundler, no transpiler beyond Node's own
 * `stripTypeScriptTypes`) from src/**.ts into the runtime layout the bundle
 * expects: src/index.ts -> index.js, src/client.ts -> client.js,
 * src/lib/*.ts -> lib/*.js.
 *
 * Usage: node build.mjs [--check]
 *   --check compares the generated text with the existing .js files and writes
 *   nothing. Exit code 0 when identical, 1 when any file differs (or is missing).
 */

import { stripTypeScriptTypes } from 'node:module'
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.join(root, 'src')
const checkOnly = process.argv.includes('--check')

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await walk(full)))
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(full)
  }
  return files
}

const files = await walk(srcDir)
const written = []
const drifted = []

for (const file of files) {
  const relative = path.relative(srcDir, file)
  const target = path.join(root, relative.slice(0, -3) + '.js')
  const source = await readFile(file, 'utf8')
  let output
  try {
    output = stripTypeScriptTypes(source, { mode: 'strip' })
  } catch (error) {
    console.error(`strip failed: ${relative}\n${error && error.message ? error.message : error}`)
    process.exitCode = 1
    continue
  }
  const banner = `// Generated from src/${relative.replace(/\\/g, '/')} - do not edit by hand; run \`node build.mjs\`.\n`
  const expected = banner + output
  if (checkOnly) {
    let current
    try {
      current = await readFile(target, 'utf8')
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
      drifted.push(`${path.relative(root, target)} (missing)`)
      continue
    }
    if (current !== expected) drifted.push(path.relative(root, target))
    continue
  }
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, expected, 'utf8')
  written.push(path.relative(root, target))
}

if (checkOnly) {
  if (drifted.length > 0) {
    console.error(`check failed: ${drifted.length} file(s) differ from src/:`)
    for (const file of drifted) console.error(`  ${file}`)
    process.exitCode = 1
  } else {
    console.log(`checked ${files.length} file(s): no differences`)
    console.log('ok')
  }
} else {
  console.log(`built ${written.length} file(s):\n  ${written.join('\n  ')}`)
  console.log('ok')
}
