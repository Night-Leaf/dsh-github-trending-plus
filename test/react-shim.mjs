/**
 * Minimal React shim: enough of createElement/useState/useEffect/useMemo to run
 * the panel components in Node and inspect the produced markup. Renders to an
 * HTML string so assertions can look for real content.
 */

let HOOKS = []
let HOOK_INDEX = 0
let PENDING_EFFECTS = []

const DEBUG = Boolean(process.env.SHIM_DEBUG)

function depsChanged(prev, next) {
  if (!prev || !next) return true
  if (prev.length !== next.length) return true
  return prev.some((value, index) => !Object.is(value, next[index]))
}

export const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity) }
  },
  useState(initial) {
    const index = HOOK_INDEX++
    if (!HOOKS[index]) HOOKS[index] = { value: typeof initial === 'function' ? initial() : initial }
    const slot = HOOKS[index]
    const set = (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next
      if (!Object.is(value, slot.value)) {
        slot.value = value
        globalThis.__SHIM_DIRTY__ = true
        if (DEBUG) console.log(`  [shim] state[${index}] changed`)
      }
    }
    return [slot.value, set]
  },
  useMemo(factory, deps) {
    const index = HOOK_INDEX++
    const slot = HOOKS[index]
    if (!slot || depsChanged(slot.deps, deps)) HOOKS[index] = { value: factory(), deps }
    return HOOKS[index].value
  },
  useEffect(fn, deps) {
    const index = HOOK_INDEX++
    const slot = HOOKS[index]
    if (!slot || depsChanged(slot.deps, deps)) {
      HOOKS[index] = { deps }
      PENDING_EFFECTS.push(fn)
      if (DEBUG) console.log(`  [shim] effect[${index}] scheduled`)
    }
  },
}

const componentHooks = new Map()
const pendingByComponent = []

function attrs(props) {
  const out = []
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children') continue
    if (value === null || value === undefined || value === false) continue
    if (key === 'style' && typeof value === 'object') {
      const css = Object.entries(value)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `${k.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase())}:${v}`)
        .join(';')
      out.push(`style="${css}"`)
      continue
    }
    if (key === 'className') {
      out.push(`class="${String(value)}"`)
      continue
    }
    if (key === 'dangerouslySetInnerHTML') continue
    if (typeof value === 'function') continue
    out.push(`${key}="${String(value)}"`)
  }
  return out.length ? ` ${out.join(' ')}` : ''
}

function renderNode(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (Array.isArray(node)) return node.map(renderNode).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node.type === 'function') {
    const saved = [HOOKS, HOOK_INDEX, PENDING_EFFECTS]
    if (!componentHooks.has(node.type)) componentHooks.set(node.type, [])
    HOOKS = componentHooks.get(node.type)
    HOOK_INDEX = 0
    PENDING_EFFECTS = []
    const output = node.type({ ...node.props, children: node.children })
    const out = renderNode(output)
    const effects = PENDING_EFFECTS
    componentHooks.set(node.type, HOOKS)
    ;[HOOKS, HOOK_INDEX, PENDING_EFFECTS] = saved
    if (effects.length) pendingByComponent.push(...effects)
    return out
  }
  return `<${node.type}${attrs(node.props)}>${node.children.map(renderNode).join('')}</${node.type}>`
}

export async function mount(element, { passes = 8 } = {}) {
  let html = ''
  for (let pass = 0; pass < passes; pass += 1) {
    pendingByComponent.length = 0
    globalThis.__SHIM_DIRTY__ = false
    html = renderNode(element)
    if (DEBUG) console.log(`  [shim] pass ${pass}: ${html.length} chars, ${pendingByComponent.length} effect(s)`)
    if (!pendingByComponent.length) break
    const queued = pendingByComponent.slice()
    pendingByComponent.length = 0
    await Promise.all(queued.map((fn) => Promise.resolve().then(fn)))
    await new Promise((res) => setTimeout(res, 30))
    if (!globalThis.__SHIM_DIRTY__) break
  }
  return html
}