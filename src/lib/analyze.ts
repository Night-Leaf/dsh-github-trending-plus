/**
 * Deterministic repository analysis.
 *
 * Everything here is rule based on purpose: the plugin must work offline-ish,
 * instantly, and identically every run, without spending model tokens. The rules
 * combine the trending signals (rank, period delta, stars, language,
 * contributors) with optional GitHub API facts (topics, licence, age, issues,
 * README excerpt) into a Chinese narrative per repository.
 */

import { detectAiModels } from './ai-models.js'
import { classifyAll } from './categories.js'
import type { CategoryRule } from './categories.js'
import type { RepoFacts } from './enrich.js'
import type { BoardSource, TrendingRepo, TrendingSince } from './trending.js'
import { PERIOD_DAYS, PERIOD_ZH } from './trending.js'
import { chineseSummary, cjkRatio, hasCjk } from './zh.js'

export interface DeepDiveBlock {
  label: string
  text: string
}

export type RiskLevel = 'low' | 'medium' | 'high'

export interface AnalyzedRepo {
  rank: number
  owner: string
  name: string
  fullName: string
  url: string
  description: string
  language: string | null
  languageColor: string | null
  stars: number
  forks: number
  delta: number
  contributors: string[]
  since: TrendingSince
  periodLabel: string
  category: string
  categoryZh: string
  categoryEn: string
  /** Every matched label, primary first; empty when nothing scored high enough. */
  categories: Array<{ key: string; zh: string; en: string }>
  stack: string[]
  /** Known AI model names mentioned by the repository itself; empty for non-AI repos. */
  aiModels: string[]
  growthRatio: number
  starsPerDay: number
  highlights: string[]
  risks: string[]
  riskLevel: RiskLevel
  intro: string
  tldr: string
  deepDive: DeepDiveBlock[]
  topics: string[]
  license: string | null
  createdAt: string | null
  pushedAt: string | null
  openIssues: number | null
  archived: boolean
  readmeSnippet: string | null
  /** README body was detected as Chinese; the client uses it for the 中文 README badge. */
  readmeZh: boolean
  /** README file that supplied the snippet, when one was fetched. */
  readmePath: string | null
  enriched: boolean
  source: BoardSource | null
}

const TOPIC_TECH: Record<string, string> = {
  react: 'React',
  vue: 'Vue',
  svelte: 'Svelte',
  nextjs: 'Next.js',
  'next-js': 'Next.js',
  nuxt: 'Nuxt',
  astro: 'Astro',
  tailwindcss: 'Tailwind CSS',
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  python: 'Python',
  rust: 'Rust',
  golang: 'Go',
  go: 'Go',
  java: 'Java',
  kotlin: 'Kotlin',
  swift: 'Swift',
  'c++': 'C++',
  cpp: 'C++',
  'c#': 'C#',
  dotnet: '.NET',
  php: 'PHP',
  ruby: 'Ruby',
  rails: 'Rails',
  django: 'Django',
  flask: 'Flask',
  fastapi: 'FastAPI',
  pytorch: 'PyTorch',
  tensorflow: 'TensorFlow',
  transformers: 'Transformers',
  langchain: 'LangChain',
  llamaindex: 'LlamaIndex',
  ollama: 'Ollama',
  openai: 'OpenAI API',
  llm: 'LLM',
  'large-language-model': 'LLM',
  'llm-agents': 'LLM Agents',
  agent: 'Agent',
  agents: 'Agent',
  rag: 'RAG',
  mcp: 'MCP',
  'model-context-protocol': 'MCP',
  docker: 'Docker',
  kubernetes: 'Kubernetes',
  k8s: 'Kubernetes',
  wasm: 'WebAssembly',
  webassembly: 'WebAssembly',
  webgl: 'WebGL',
  threejs: 'Three.js',
  postgres: 'PostgreSQL',
  postgresql: 'PostgreSQL',
  sqlite: 'SQLite',
  redis: 'Redis',
  kafka: 'Kafka',
  clickhouse: 'ClickHouse',
  duckdb: 'DuckDB',
  graphql: 'GraphQL',
  grpc: 'gRPC',
  electron: 'Electron',
  tauri: 'Tauri',
  flutter: 'Flutter',
  'react-native': 'React Native',
  vscode: 'VS Code',
  neovim: 'Neovim',
  cli: 'CLI',
  'developer-tools': 'DevTools',
  automation: 'Automation',
  'machine-learning': 'Machine Learning',
  'deep-learning': 'Deep Learning',
  'computer-vision': 'Computer Vision',
  nlp: 'NLP',
  security: 'Security',
  blockchain: 'Blockchain',
  'self-hosted': 'Self-hosted',
  observability: 'Observability',
}

const TECH_KEYWORDS: Array<[RegExp, string]> = [
  [/\breact\b/i, 'React'],
  [/\bnext\.?js\b/i, 'Next.js'],
  [/\bvue\b/i, 'Vue'],
  [/\bsvelte\b/i, 'Svelte'],
  [/\bnuxt\b/i, 'Nuxt'],
  [/\bastro\b/i, 'Astro'],
  [/\btailwind\b/i, 'Tailwind CSS'],
  [/\belectron\b/i, 'Electron'],
  [/\btauri\b/i, 'Tauri'],
  [/\bdeno\b/i, 'Deno'],
  [/\bbun\b/i, 'Bun'],
  [/\bnode\.?js\b/i, 'Node.js'],
  [/\bfastapi\b/i, 'FastAPI'],
  [/\bdjango\b/i, 'Django'],
  [/\bflask\b/i, 'Flask'],
  [/\bpytorch\b/i, 'PyTorch'],
  [/\btensorflow\b/i, 'TensorFlow'],
  [/\bvllm\b/i, 'vLLM'],
  [/\bollama\b/i, 'Ollama'],
  [/\blangchain\b/i, 'LangChain'],
  [/\blanggraph\b/i, 'LangGraph'],
  [/\bmcp\b/i, 'MCP'],
  [/\brag\b/i, 'RAG'],
  [/\btransformer/i, 'Transformers'],
  [/\bgrpc\b/i, 'gRPC'],
  [/\bgraphql\b/i, 'GraphQL'],
  [/\bpostgres/i, 'PostgreSQL'],
  [/\bsqlite\b/i, 'SQLite'],
  [/\bredis\b/i, 'Redis'],
  [/\bkafka\b/i, 'Kafka'],
  [/\bclickhouse\b/i, 'ClickHouse'],
  [/\bduckdb\b/i, 'DuckDB'],
  [/\bkubernetes\b/i, 'Kubernetes'],
  [/\bdocker\b/i, 'Docker'],
  [/\bwasm\b|webassembly/i, 'WebAssembly'],
  [/\bwebgpu\b/i, 'WebGPU'],
  [/\bthree\.?js\b/i, 'Three.js'],
  [/\btokio\b/i, 'Tokio'],
  [/\baxum\b/i, 'Axum'],
  [/\bflutter\b/i, 'Flutter'],
  [/\bswiftui\b/i, 'SwiftUI'],
  [/\bsolidity\b/i, 'Solidity'],
  [/\bneovim\b/i, 'Neovim'],
  [/\bkubernetes operator\b/i, 'Operator'],
  [/\bagent(ic|s)?\b/i, 'Agent 框架'],
  [/\bllms?\b|large language model/i, 'LLM 推理'],
  [/\binference\b/i, '推理引擎'],
  [/\bcuda\b/i, 'CUDA'],
  [/\bgpu\b/i, 'GPU'],
  [/\b(tts|asr|speech)\b/i, '语音处理'],
  [/\bembeddings?\b|vector (db|database|search)/i, '向量检索'],
  [/\bwifi|wi-fi\b/i, '无线信号处理'],
  [/\b(proxy|tunnel|vpn)\b/i, '网络代理'],
  [/\bcli\b|command[- ]line/i, 'CLI 工具'],
  [/\bterminal\b/i, '终端增强'],
  [/\b(sql|query engine|olap)\b/i, 'SQL 引擎'],
  [/\b(benchmark|evaluation|eval harness)\b/i, '评测基准'],
  [/\b(plugin|extension|sdk)\b/i, '插件生态'],
  [/\b(desktop app|electron|tauri)\b/i, '桌面应用'],
]

const LANGUAGE_ECOSYSTEM: Record<string, string> = {
  Rust: 'Cargo',
  Go: 'Go Modules',
  TypeScript: 'npm',
  JavaScript: 'npm',
  Python: 'PyPI',
  Java: 'Maven / Gradle',
  'C++': 'CMake',
  C: 'Make',
  Swift: 'SwiftPM',
  Kotlin: 'Gradle',
  Ruby: 'RubyGems',
  PHP: 'Composer',
  'C#': 'NuGet',
  Dart: 'pub',
  Zig: 'build.zig',
  Elixir: 'Mix',
  Haskell: 'Cabal',
  Lua: 'LuaRocks',
}

export function inferStack(repo: TrendingRepo, facts: RepoFacts): string[] {
  const out: string[] = []
  const push = (value: string) => {
    const label = value.trim()
    if (!label) return
    if (out.some((item) => item.toLowerCase() === label.toLowerCase())) return
    if (out.length < 6) out.push(label)
  }
  if (repo.language) push(repo.language)
  for (const topic of facts.topics) {
    const mapped = TOPIC_TECH[topic.toLowerCase()]
    if (mapped) push(mapped)
  }
  const blob = `${repo.name} ${repo.description} ${facts.topics.join(' ')} ${(facts.readmeSnippet ?? '').slice(0, 260)}`
  for (const [pattern, label] of TECH_KEYWORDS) {
    if (pattern.test(blob)) push(label)
  }
  if (out.length === 0) push('未标注')
  else if (out.length === 1 && repo.language) {
    const ecosystem = LANGUAGE_ECOSYSTEM[repo.language]
    if (ecosystem) push(ecosystem)
  }
  return out
}

/** Automated accounts that show up in GitHub's "Built by" list. */
const BOT_LOGIN = /^(claude|cursoragent|copilot|github-actions|dependabot|renovate|vercel|codex|devin|sweep|aider|openhands|qodo)(\[bot\])?$/i

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(value))
}

/** Human phrasing for a category bucket; the fallback bucket reads better as prose. */
function categoryPhrase(category: CategoryRule | null): string {
  if (!category) return '暂未匹配到固定分类，属于待观察项目'
  return `属于 ${category.zh} 方向`
}

function percent(value: number): string {
  const pct = value * 100
  if (pct >= 10) return `${pct.toFixed(0)}%`
  if (pct >= 1) return `${pct.toFixed(1)}%`
  return `${pct.toFixed(2)}%`
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return null
  return Math.max(0, Math.round((Date.now() - time) / 86400000))
}

function firstSentence(text: string, max = 160): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  const match = /^[^.!?。！？]{10,400}[.!?。！？]/.exec(trimmed)
  const sentence = match ? match[0] : trimmed
  return sentence.length > max ? `${sentence.slice(0, max).trim()}…` : sentence
}

/** Appends a full stop unless the text already ends with punctuation. */
function sentenceEnd(text: string): string {
  const trimmed = String(text ?? '')
    .trim()
    .replace(/([。！？.!?…])(\s*[。.])+$/, '$1')
  if (!trimmed) return ''
  if (/[。！？.!?…]$/.test(trimmed)) return trimmed
  return /[A-Za-z0-9)\]}'"”]$/.test(trimmed) ? `${trimmed}.` : `${trimmed}。`
}

export interface AnalyzeOptions {
  since: TrendingSince
  focusCount?: number
}

export function analyzeRepo(repo: TrendingRepo, facts: RepoFacts, options: AnalyzeOptions): AnalyzedRepo {
  const since = options.since
  const periodZh = PERIOD_ZH[since]
  const days = PERIOD_DAYS[since]
  const categories = classifyAll(repo, facts)
  const primary = categories.length > 0 ? categories[0] : null
  const stack = inferStack(repo, facts)
  const stars = repo.stars || 0
  const delta = repo.delta || 0
  const growthRatio = stars > 0 ? delta / Math.max(stars - delta, 1) : 0
  const starsPerDay = delta / days
  const age = daysSince(facts.createdAt)
  const issueRatio = stars > 0 && facts.openIssues !== null ? facts.openIssues / stars : 0
  const language = repo.language
  const contributors = repo.contributors.filter((login) => !BOT_LOGIN.test(login))

  const introBits: string[] = []
  introBits.push(`${repo.name} ${categoryPhrase(primary)}`)
  if (language) introBits.push(`以 ${language} 为主要实现语言`)
  introBits.push(`当前累计 ${formatNumber(stars)} star`)
  if (delta > 0) introBits.push(`${periodZh}新增 ${formatNumber(delta)} star`)
  const intro = `${introBits.join('，')}。`

  const highlights: string[] = []
  const risks: string[] = []

  if (repo.rank <= 3) highlights.push(`位列${periodZh}榜第 ${repo.rank} 名，是本期最受关注的项目之一`)
  else if (repo.rank <= 8) highlights.push(`进入${periodZh}榜前 ${repo.rank} 名`)

  if (growthRatio >= 0.1) highlights.push(`周期内 star 增长 ${percent(growthRatio)}，处于高速扩散阶段`)
  else if (growthRatio >= 0.03) highlights.push(`周期内 star 增长 ${percent(growthRatio)}，热度稳定上升`)

  if (stars >= 50000) highlights.push(`累计 ${formatNumber(stars)} star，已是社区级成熟项目`)
  else if (stars >= 10000) highlights.push(`累计 ${formatNumber(stars)} star，社区基础扎实`)
  else if (delta >= 300 && stars > 0) highlights.push(`在 ${formatNumber(stars)} star 的基数上仍取得 ${formatNumber(delta)} 的周期增量`)

  const aiTopic = facts.topics.some((topic) => /(^|-)ai($|-)|llm|agent|gpt|model/.test(topic.toLowerCase()))
  if (aiTopic || categories.some((entry) => entry.key === 'ai')) highlights.push('处于 AI / 大模型主赛道，与当前技术热点高度重合')

  if (facts.readmeSnippet) {
    const sentence = firstSentence(facts.readmeSnippet, 140)
    if (sentence) highlights.push(`README 自述：${sentence}`)
  }

  if (contributors.length >= 3) {
    highlights.push(`由 ${contributors.slice(0, 3).join('、')} 等 ${contributors.length} 位贡献者共同维护`)
  }
  if (facts.license && facts.license !== 'NOASSERTION') highlights.push(`采用 ${facts.license} 许可证，授权边界清晰`)

  if (stars < 500) risks.push(`star 基数较小（${formatNumber(stars)}），文档与生态成熟度有待验证`)
  if (growthRatio > 0.3) risks.push(`周期增速达 ${percent(growthRatio)}，短期热度偏高，需警惕炒作与回落`)
  if (age !== null && age <= 90) risks.push(`项目创建仅 ${age} 天，接口与方向可能频繁变动`)
  else if (age !== null && age <= 365) risks.push(`项目创建于 ${facts.createdAt?.slice(0, 10)}，仍处于早期迭代阶段`)
  if (facts.archived) risks.push('仓库已归档，官方不再演进')
  if (!facts.license && facts.enriched) risks.push('未获取到许可证信息，商用前需确认授权')
  if (facts.openIssues !== null && facts.openIssues >= 50 && issueRatio > 0.06) {
    risks.push(`开放 issue ${formatNumber(facts.openIssues)} 个，相对 star 规模积压偏多`)
  }
  if (contributors.length === 1) risks.push('核心贡献者高度集中，存在单点维护风险')
  if (!repo.description) risks.push('仓库未提供简介，项目信息透明度较低')
  if (!language) risks.push('未标注主要语言，技术栈信息不完整')
  if (risks.length === 0) risks.push('暂无明显风险信号，但生产可用性仍需自行评估')

  const riskLevel: RiskLevel = risks.length >= 4 ? 'high' : risks.length >= 2 ? 'medium' : 'low'

  const tldr = repo.description
    ? firstSentence(repo.description, 120)
    : `${primary ? `${primary.zh}项目` : '暂未匹配固定分类的项目'}，${language ?? '语言未标注'}，${periodZh}新增 ${formatNumber(delta)} star。`

  const isAi = categories.some((entry) => entry.key === 'ai')
  const aiModels = detectAiModels(
    { name: repo.name, description: repo.description, topics: facts.topics, readmeSnippet: facts.readmeSnippet },
    isAi,
  )

  const deepDive: DeepDiveBlock[] = []
  deepDive.push({
    label: '项目介绍',
    text: positioningText(repo, primary, facts, stack),
  })
  deepDive.push({
    label: '技术栈',
    text: `${stack.join(' / ')}${facts.topics.length ? `；仓库 topics：${facts.topics.slice(0, 8).join(', ')}` : ''}。`,
  })
  const onboarding = onboardingText(repo, facts, stack)
  if (onboarding) deepDive.push({ label: '上手门槛', text: onboarding })
  deepDive.push({
    label: '需要留意',
    text: sentenceEnd(risks.join('；')),
  })

  return {
    rank: repo.rank,
    owner: repo.owner,
    name: repo.name,
    fullName: repo.fullName,
    url: repo.url,
    description: repo.description,
    language,
    languageColor: repo.languageColor,
    stars,
    forks: repo.forks,
    delta,
    contributors,
    since,
    periodLabel: periodZh,
    category: primary ? primary.key : '',
    categoryZh: primary ? primary.zh : '',
    categoryEn: primary ? primary.en : '',
    categories: categories.map((entry) => ({ key: entry.key, zh: entry.zh, en: entry.en })),
    stack,
    aiModels,
    growthRatio,
    starsPerDay,
    highlights: highlights.slice(0, 5),
    risks: risks.slice(0, 4),
    riskLevel,
    intro,
    tldr,
    deepDive,
    topics: facts.topics,
    license: facts.license,
    createdAt: facts.createdAt,
    pushedAt: facts.pushedAt,
    openIssues: facts.openIssues,
    archived: facts.archived,
    readmeSnippet: facts.readmeSnippet,
    readmeZh: facts.readmeZh === true,
    readmePath: facts.readmePath ?? null,
    enriched: facts.enriched,
    source: repo.source ?? null,
  }
}

/**
 * "项目介绍" stays Chinese: a Chinese description is quoted as-is (category
 * phrase + sentence); an English description is replaced by a Chinese summary
 * built from category, topics and stack. Star/fork/growth/contributor figures
 * belong to the metric row, not here.
 */
function positioningText(
  repo: TrendingRepo,
  primary: CategoryRule | null,
  facts: RepoFacts,
  stack: string[],
): string {
  const category = primary ? `${categoryPhrase(primary)}。` : ''
  if (repo.description) {
    if (hasCjk(repo.description) && cjkRatio(repo.description) >= 0.3) {
      return `${category}${sentenceEnd(firstSentence(repo.description, 140))}`
    }
    return chineseSummary({
      name: repo.name,
      language: repo.language,
      categoryZh: primary ? primary.zh : '',
      topics: facts.topics,
      stack,
      description: repo.description,
    })
  }
  return `${category}${repo.name} 是一个开源项目，仓库未提供官方简介。`
}

/** Keywords that mark a repository as a resource collection, not a runnable project. */
const RESOURCE_KEYWORDS_EN = [
  'awesome',
  'list',
  'collection',
  'course',
  'courses',
  'tutorial',
  'tutorials',
  'book',
  'books',
  'notes',
  'paper',
  'papers',
  'lecture',
  'lectures',
  'cheatsheet',
  'roadmap',
  'guide',
  'curated',
]
const RESOURCE_KEYWORDS_ZH = ['资源', '合集', '教程', '公开课', '笔记', '书单']
const RESOURCE_EN_RE = new RegExp(`\\b(?:${RESOURCE_KEYWORDS_EN.join('|')})\\b`, 'i')

/** Fixed 上手门槛 text for resource repositories: browse, nothing to install. */
export const RESOURCE_ONBOARDING_TEXT = '为特定专业领域的学术资源，直接浏览即可，无需安装。'

/**
 * A resource repository (awesome list, papers, course notes, ...) is consumed by
 * reading it, so it gets a fixed 上手门槛 sentence instead of prerequisites.
 * Keywords are matched case-insensitively against the name, description and
 * topics; English keywords need word boundaries so "list" does not match
 * "listen" and "notes" does not match "notebook".
 */
export function isResourceRepo(repo: TrendingRepo, facts: RepoFacts): boolean {
  const blob = [repo.name, repo.description ?? '', ...(Array.isArray(facts.topics) ? facts.topics : [])]
    .join(' ')
    .toLowerCase()
  if (RESOURCE_EN_RE.test(blob)) return true
  return RESOURCE_KEYWORDS_ZH.some((word) => blob.includes(word))
}

/**
 * "上手门槛" answers exactly two questions: what you need to know first and how
 * far the first README run gets you. It never estimates time. Resource
 * repositories get a fixed sentence; without README or topic evidence there is
 * nothing to base a runnable answer on, so the whole block is omitted.
 */
function onboardingText(repo: TrendingRepo, facts: RepoFacts, stack: string[]): string | null {
  if (isResourceRepo(repo, facts)) return RESOURCE_ONBOARDING_TEXT
  const hasEvidence = Boolean(facts.readmeSnippet) || facts.topics.length > 0
  if (!hasEvidence) return null
  const prerequisites: string[] = []
  if (repo.language) prerequisites.push(repo.language)
  const extra = stack.find(
    (item) => Boolean(item) && item !== repo.language && !prerequisites.includes(item),
  )
  if (extra) prerequisites.push(extra)
  const known = prerequisites.length > 0 ? prerequisites.join('、') : '命令行与 Git'
  return `需要先会：${known}。第一次能跑到：按 README 安装并跑通第一个示例。`
}

export function analyzeRepos(
  repos: TrendingRepo[],
  facts: Map<string, RepoFacts>,
  options: AnalyzeOptions,
): AnalyzedRepo[] {
  return repos.map((repo) => analyzeRepo(repo, facts.get(repo.fullName) ?? emptyFactsFallback(repo.fullName), options))
}

function emptyFactsFallback(fullName: string): RepoFacts {
  return {
    fullName,
    enriched: false,
    topics: [],
    license: null,
    archived: false,
    createdAt: null,
    pushedAt: null,
    openIssues: null,
    homepage: null,
    readmeSnippet: null,
    readmeZh: false,
    readmePath: null,
    note: 'not enriched',
  }
}