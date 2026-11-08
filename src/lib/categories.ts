/**
 * Fixed category catalogue and multi-label classification.
 *
 * The catalogue is intentionally closed: 13 buckets, no "other" fallback. A
 * repository that matches nothing stays uncategorised (an empty array), which
 * the panel renders without a category chip instead of inventing a bucket.
 *
 * Scoring is deterministic and rule based. Each matching keyword contributes:
 *   topics +3, name +2, description +1.5, README excerpt +0.3
 * and a declared language adds +1.2. Every rule that reaches the 1.5 threshold
 * is a label; the highest score is the primary category, capped at three tags.
 */

import type { RepoFacts } from './enrich.js'
import type { TrendingRepo } from './trending.js'

export interface CategoryRule {
  key: string
  zh: string
  en: string
  keywords: string[]
  /** Languages that are a strong signal on their own for this bucket. */
  languages?: string[]
}

export const CATEGORY_CATALOG: CategoryRule[] = [
  {
    key: 'ai',
    zh: 'AI / 大模型',
    en: 'AI / LLM',
    keywords: [
      'llm', 'agent', 'agents', 'gpt', 'openai', 'claude', 'gemini', 'llama', 'ollama', 'rag', 'embedding',
      'transformer', 'diffusion', 'inference', 'fine-tun', 'prompt', 'mcp', 'copilot', 'chatbot', 'nlp',
      'vision', 'multimodal', 'speech', 'whisper', 'tutor', 'reasoning', 'neural', 'deep learning', 'pytorch',
      'tensorflow', 'vector database', 'ai', 'model',
    ],
  },
  {
    key: 'devtool',
    zh: '开发者工具',
    en: 'Developer tools',
    keywords: [
      'cli', 'terminal', 'shell prompt', 'compiler', 'linter', 'formatter', 'debugger', 'sdk', 'build system',
      'bundler', 'toolchain', 'vscode', 'neovim', 'vim', 'tmux', 'git ', 'monorepo', 'test runner', 'testing',
      'documentation', 'static site', 'generator', 'scaffold', 'devtools', 'developer tools', 'ide', 'editor',
      'package manager', 'runtime', 'interpreter', 'parser', 'codegen', 'skills', 'methodology', 'workflow',
    ],
  },
  {
    key: 'web',
    zh: 'Web / 前端',
    en: 'Web / frontend',
    keywords: [
      'react', 'vue', 'svelte', 'angular', 'next.js', 'nextjs', 'nuxt', 'remix', 'astro', 'solid',
      'tailwind', 'css', 'html', 'dom', 'frontend', 'ui component', 'component library', 'design system',
      'three.js', 'webgl', 'webgpu', 'animation', 'browser', 'pwa', 'electron', 'tauri', 'web app',
    ],
  },
  {
    key: 'infra',
    zh: '基础设施 / 云原生',
    en: 'Infra / cloud native',
    keywords: [
      'kubernetes', 'k8s', 'docker', 'container', 'serverless', 'terraform', 'operator', 'proxy', 'gateway',
      'nginx', 'service mesh', 'observability', 'monitoring', 'prometheus', 'grafana', 'wasm', 'webassembly',
      'distributed', 'orchestration', 'cloud', 'devops', 'ci/cd', 'deployment', 'load balancer', 'networking',
      'storage engine', 'filesystem', 'virtual machine', 'hypervisor',
    ],
  },
  {
    key: 'data',
    zh: '数据 / 数据库',
    en: 'Data / database',
    keywords: [
      'database', 'sql', 'postgres', 'postgresql', 'mysql', 'sqlite', 'clickhouse', 'duckdb', 'kafka',
      'stream processing', 'etl', 'analytics', 'query engine', 'dataframe', 'pandas', 'spark', 'parquet',
      'olap', 'oltp', 'bi ', 'data pipeline', 'data warehouse', 'time series', 'search engine', 'index',
    ],
  },
  {
    key: 'security',
    zh: '安全',
    en: 'Security',
    keywords: [
      'security', 'vulnerability', 'pentest', 'penetration', 'exploit', 'cryptography', 'encryption', 'auth',
      'oauth', 'sandbox', 'malware', 'fuzzing', 'cve', 'zero trust', 'secrets', 'tls', 'firewall', 'scanner',
    ],
  },
  {
    key: 'mobile',
    zh: '移动端',
    en: 'Mobile',
    keywords: ['android', 'ios', 'flutter', 'react native', 'swiftui', 'jetpack compose', 'kotlin multiplatform', 'mobile app'],
    languages: ['Swift', 'Kotlin', 'Dart'],
  },
  {
    key: 'blockchain',
    zh: '区块链 / Web3',
    en: 'Blockchain / Web3',
    keywords: ['blockchain', 'ethereum', 'solana', 'smart contract', 'defi', 'nft', 'web3', 'solidity', 'onchain', 'evm'],
    languages: ['Solidity'],
  },
  {
    key: 'learning',
    zh: '学习',
    en: 'Learning',
    keywords: [
      'tutorial', 'course', 'book', 'awesome', 'interview', 'roadmap', 'handbook', 'guide', 'cheatsheet',
      'learning', 'notes', 'examples', 'curriculum', 'paper', 'papers', 'study',
    ],
  },
  {
    key: 'productivity',
    zh: '效率 / 自动化',
    en: 'Productivity',
    keywords: ['automation', 'workflow', 'productivity', 'note', 'notes app', 'task', 'todo', 'calendar', 'sync', 'scraper', 'crawler'],
  },
  {
    key: 'game',
    zh: '游戏 / 图形',
    en: 'Game / graphics',
    keywords: [
      'game', 'game engine', 'gamedev', 'game development', 'graphics', 'rendering', 'renderer', 'shader',
      'opengl', 'vulkan', 'directx', 'unity', 'unreal', 'godot', 'minecraft', 'raytracing', 'ray tracing',
      'pixel art', 'sprite', '3d', 'physics engine', 'emulator', 'game console', 'metaverse', 'xr', 'vr',
    ],
    languages: ['GDScript'],
  },
  {
    key: 'hardware',
    zh: '硬件 / 嵌入式',
    en: 'Hardware / embedded',
    keywords: [
      'hardware', 'embedded', 'firmware', 'microcontroller', 'arduino', 'raspberry pi', 'esp32', 'esp8266',
      'stm32', 'rtos', 'fpga', 'verilog', 'vhdl', 'iot', 'internet of things', 'robotics', 'robot',
      'kernel module', 'device driver', 'gpio', 'pcb', 'risc-v', 'riscv', 'arm cortex', 'serial port',
      'usb', 'bluetooth', 'zigbee', 'lora',
    ],
    languages: ['Verilog', 'VHDL', 'Assembly'],
  },
  {
    key: 'research',
    zh: '科研 / 论文',
    en: 'Research',
    keywords: [
      'research', 'paper', 'papers', 'arxiv', 'scientific', 'science', 'academic', 'preprint', 'citation',
      'thesis', 'journal', 'conference', 'experiment', 'reproducibility', 'reproducible', 'dataset', 'benchmark',
      'survey', 'peer review', 'laboratory', 'bioinformatics', 'computational',
    ],
  },
]

interface CompiledRule {
  rule: CategoryRule
  matchers: RegExp[]
  languages: string[]
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Short tokens (ai, go, ui, bi, cli) are matched on word boundaries so they do
 * not fire inside longer words; longer phrases are matched as plain substrings.
 */
const COMPILED_RULES: CompiledRule[] = CATEGORY_CATALOG.map((rule) => ({
  rule,
  matchers: rule.keywords.map((keyword) => {
    const needle = keyword.trim().toLowerCase()
    if (needle.length <= 3) return new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}([^a-z0-9]|$)`, 'i')
    return new RegExp(escapeRegExp(needle), 'i')
  }),
  languages: (rule.languages ?? []).map((language) => language.toLowerCase()),
}))

const MIN_SCORE = 1.5
const MAX_TAGS = 3

interface ScoreParts {
  name: string
  description: string
  topics: string
  readme: string
  language: string
}

function scoreRule(compiled: CompiledRule, parts: ScoreParts): number {
  let score = 0
  for (const matcher of compiled.matchers) {
    if (matcher.test(parts.topics)) score += 3
    if (matcher.test(parts.name)) score += 2
    if (matcher.test(parts.description)) score += 1.5
    if (matcher.test(parts.readme)) score += 0.3
  }
  if (parts.language && compiled.languages.includes(parts.language)) score += 1.2
  return score
}

export interface ScoredCategory {
  rule: CategoryRule
  score: number
}

/** Every rule scoring at least 1.5, best first, capped at three labels. */
export function classifyAllScored(repo: TrendingRepo, facts: RepoFacts): ScoredCategory[] {
  const parts: ScoreParts = {
    name: (repo.name || '').toLowerCase(),
    description: (repo.description || '').toLowerCase(),
    topics: (facts.topics ?? []).join(' ').toLowerCase(),
    readme: (facts.readmeSnippet || '').toLowerCase(),
    language: (repo.language || '').toLowerCase(),
  }
  const hits: ScoredCategory[] = []
  COMPILED_RULES.forEach((compiled) => {
    const score = scoreRule(compiled, parts)
    if (score >= MIN_SCORE) hits.push({ rule: compiled.rule, score })
  })
  hits.sort((a, b) => b.score - a.score || CATEGORY_CATALOG.indexOf(a.rule) - CATEGORY_CATALOG.indexOf(b.rule))
  return hits.slice(0, MAX_TAGS)
}

/** All labels for a repository, primary first; an empty array means no match. */
export function classifyAll(repo: TrendingRepo, facts: RepoFacts): CategoryRule[] {
  return classifyAllScored(repo, facts).map((hit) => hit.rule)
}
