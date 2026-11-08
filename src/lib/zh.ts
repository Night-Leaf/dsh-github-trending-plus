/**
 * Chinese-only phrasing helpers.
 *
 * The card's "项目介绍" section must read as Chinese prose. Repository
 * descriptions on GitHub are often English, so instead of copying them we
 * describe the repository from its category, topics and stack. The glossary
 * below is the only place English source words are allowed: unknown words are
 * dropped rather than printed as-is.
 */

const CJK = /[\u4e00-\u9fff]/

/** True when the text contains at least one CJK character. */
export function hasCjk(text: string): boolean {
  return CJK.test(String(text ?? ''))
}

/** Share of non-whitespace characters that are CJK; 0 for empty text. */
export function cjkRatio(text: string): number {
  const chars = Array.from(String(text ?? '').replace(/\s+/g, ''))
  if (chars.length === 0) return 0
  let cjk = 0
  for (const char of chars) if (CJK.test(char)) cjk += 1
  return cjk / chars.length
}

/**
 * English term -> Chinese term. Keys are lowercase and hyphen separated.
 * Values must stay Chinese (or a whitelisted acronym such as AI / MCP) so a
 * translated summary never smuggles an English word back in.
 */
export const TOPIC_GLOSSARY: Record<string, string> = {
  // AI / models
  agent: '智能体',
  agents: '智能体',
  ai: 'AI',
  llm: '大模型',
  llms: '大模型',
  rag: '检索增强',
  embedding: '向量化',
  embeddings: '向量化',
  inference: '推理',
  'fine-tuning': '微调',
  finetuning: '微调',
  dataset: '数据集',
  datasets: '数据集',
  benchmark: '基准测试',
  benchmarks: '基准测试',
  model: '模型',
  models: '模型',
  training: '训练',
  prompt: '提示词',
  prompts: '提示词',
  mcp: 'MCP 协议',
  multimodal: '多模态',
  'machine-learning': '机器学习',
  'deep-learning': '深度学习',
  'neural-network': '神经网络',
  'computer-vision': '计算机视觉',
  nlp: '自然语言处理',
  speech: '语音',
  tts: '语音合成',
  asr: '语音识别',
  transformer: '变换器模型',
  diffusion: '扩散模型',
  gpt: '生成式模型',
  chatgpt: '对话模型',
  chatbot: '对话机器人',
  openai: '对话模型',
  ollama: '本地模型运行',
  langchain: '模型应用框架',
  'vector-database': '向量数据库',
  'vector-search': '向量检索',
  quantization: '量化',
  'quantization-aware-training': '量化训练',

  // software shape
  framework: '框架',
  library: '库',
  toolkit: '工具集',
  cli: '命令行工具',
  sdk: '开发工具包',
  api: '接口',
  server: '服务端',
  client: '客户端',
  plugin: '插件',
  extension: '扩展',
  compiler: '编译器',
  parser: '解析器',
  database: '数据库',
  cache: '缓存',
  proxy: '代理',
  gateway: '网关',
  automation: '自动化',
  workflow: '工作流',
  monitoring: '监控',
  dashboard: '面板',
  security: '安全',
  encryption: '加密',
  crawler: '爬虫',
  scraper: '抓取工具',
  bot: '机器人',
  image: '图像',
  video: '视频',
  audio: '音频',
  ocr: '文字识别',
  quant: '量化',
  trading: '交易',
  visualization: '可视化',

  // data
  'data-science': '数据科学',
  'data-analysis': '数据分析',
  analytics: '数据分析',
  dataframe: '数据表',
  etl: '数据清洗',
  pipeline: '流水线',
  'data-pipeline': '数据流水线',
  sql: 'SQL',
  nosql: '非关系型数据库',
  postgres: '关系型数据库',
  postgresql: '关系型数据库',
  mysql: '关系型数据库',
  sqlite: '嵌入式数据库',
  duckdb: '分析型数据库',
  clickhouse: '分析型数据库',
  redis: '缓存',
  kafka: '消息队列',
  graphql: '查询接口',
  grpc: '远程调用',
  rest: '网络接口',
  http: '网络请求',
  websocket: '实时通信',

  // infra
  docker: '容器',
  kubernetes: '容器编排',
  k8s: '容器编排',
  container: '容器',
  serverless: '无服务器',
  terraform: '基础设施编排',
  operator: '运维组件',
  devops: '研发运维',
  'ci-cd': '持续集成',
  deployment: '部署',
  observability: '可观测性',
  logging: '日志',
  tracing: '链路追踪',
  prometheus: '指标监控',
  grafana: '可视化面板',
  networking: '网络',
  'load-balancer': '负载均衡',
  'message-queue': '消息队列',
  microservice: '微服务',
  distributed: '分布式',
  orchestration: '编排',
  storage: '存储',
  filesystem: '文件系统',

  // web / frontend
  web: '网页',
  web3: '区块链',
  frontend: '前端',
  backend: '后端',
  fullstack: '全栈',
  react: '前端框架',
  vue: '前端框架',
  svelte: '前端框架',
  nextjs: '全栈框架',
  'next-js': '全栈框架',
  nuxt: '全栈框架',
  astro: '内容站点框架',
  tailwindcss: '样式框架',
  css: '样式',
  html: '网页',
  typescript: '类型化脚本',
  javascript: '脚本语言',
  python: '脚本语言',
  rust: '系统编程语言',
  golang: '编程语言',
  go: '编程语言',
  java: '编程语言',
  kotlin: '编程语言',
  swift: '编程语言',
  flutter: '跨端框架',
  'react-native': '跨端框架',
  electron: '桌面应用框架',
  tauri: '桌面应用框架',
  android: '安卓',
  ios: '苹果端',
  mobile: '移动端',
  desktop: '桌面端',
  browser: '浏览器',

  // graphics / games
  game: '游戏',
  gamedev: '游戏开发',
  graphics: '图形',
  rendering: '渲染',
  webgl: '网页三维',
  threejs: '三维渲染',
  animation: '动画',
  '3d': '三维',

  // productivity / learning
  productivity: '效率工具',
  note: '笔记',
  notes: '笔记',
  todo: '待办',
  calendar: '日历',
  task: '任务管理',
  sync: '同步',
  'self-hosted': '自托管',
  'open-source': '开源',
  awesome: '资源清单',
  tutorial: '教程',
  guide: '指南',
  course: '课程',
  book: '书籍',
  roadmap: '学习路线',
  interview: '面试',
  learning: '学习',
  education: '教育',

  // hardware / research
  hardware: '硬件',
  embedded: '嵌入式',
  iot: '物联网',
  firmware: '固件',
  research: '科研',
  paper: '论文',
  papers: '论文',

  // blockchain
  blockchain: '区块链',
  ethereum: '以太坊',
  solana: '索拉纳',
  'smart-contract': '智能合约',
  defi: '去中心化金融',
  nft: '数字藏品',
  solidity: '智能合约语言',

  // security
  'security-tools': '安全工具',
  vulnerability: '漏洞',
  pentest: '渗透测试',
  cryptography: '密码学',
  authentication: '身份认证',
  oauth: 'OAuth 授权',
  firewall: '防火墙',
  malware: '恶意软件',

  // high-frequency GitHub trending description words
  ui: '界面',
  audit: '审计',
  skill: '技能包',
  skills: '技能包',
  template: '模板',
  boilerplate: '脚手架',
  starter: '起步模板',
  component: '组件',
  design: '设计',
  theme: '主题',
  engine: '引擎',
  simulation: '仿真',
  terminal: '终端',
  shell: '命令行',
  editor: '编辑器',
  ide: '开发环境',
  assistant: '助手',
  copilot: '编码助手',
  coding: '编程',
  code: '代码',
  review: '评审',
  test: '测试',
  debug: '调试',
  deploy: '部署',
  cloud: '云',
  edge: '边缘',
  streaming: '流式',
  vision: '视觉',
  detection: '检测',
  segmentation: '分割',
  render: '渲染',
  shader: '着色器',
  math: '数学',
  physics: '物理',
  finance: '金融',
  scraping: '抓取',
  vector: '向量',
  evaluation: '评测',
  'multi-agent': '多智能体',
  tool: '工具',
  gui: '图形界面',
  queue: '队列',
  auth: '认证',
  privacy: '隐私',
  metrics: '指标',
  charts: '图表',
  markdown: 'Markdown',
  pdf: 'PDF',
  docx: 'Word 文档',
  excel: '表格',
  spreadsheet: '电子表格',
  'retrieval-augmented-generation': '检索增强',

  // search / indexing
  search: '搜索',
  'search-engine': '搜索引擎',
  indexing: '索引',
}

function normalizeTerm(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .trim()
    .replace(/[_\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function pushUnique(out: string[], value: string): void {
  if (value && !out.includes(value)) out.push(value)
}

/**
 * Translate English words/phrases through the glossary. A whole-phrase hit
 * wins; otherwise known tokens inside the phrase are translated and unknown
 * tokens are dropped. The result never contains the untranslated input.
 */
export function translateTerms(words: string[]): string[] {
  const out: string[] = []
  for (const word of words ?? []) {
    const normalized = normalizeTerm(word)
    if (!normalized) continue
    const direct = TOPIC_GLOSSARY[normalized]
    if (direct) {
      pushUnique(out, direct)
      continue
    }
    const tokens = normalized.split(/[^a-z0-9+#]+/).filter(Boolean)
    for (const token of tokens) {
      const mapped = TOPIC_GLOSSARY[token]
      if (mapped) pushUnique(out, mapped)
    }
  }
  return out
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeMatchText(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim()
}

/**
 * Find glossary terms inside an English description. Keys are tried longest
 * first, so a specific phrase ("retrieval-augmented-generation") wins before
 * a short one ("rag"). Matching is token-bounded, so "go" does not fire inside
 * "google".
 */
function descriptionTerms(description: string): string[] {
  const text = normalizeMatchText(description)
  if (!text) return []
  const entries = Object.keys(TOPIC_GLOSSARY)
    .map((key) => ({ key, needle: key.replace(/-/g, ' ') }))
    .filter((entry) => entry.needle.length >= 2)
    .sort((a, b) => b.needle.length - a.needle.length)
  const out: string[] = []
  for (const { key, needle } of entries) {
    const pattern = new RegExp(`(?:^| )${escapeRegExp(needle)}(?: |$)`)
    if (pattern.test(text)) pushUnique(out, TOPIC_GLOSSARY[key])
  }
  return out
}

/**
 * Category labels occasionally carry an English word ("Web / 前端",
 * "区块链 / Web3"). Strip it so the summary sentence stays Chinese; "AI" is
 * whitelisted and may remain.
 */
function pureCategoryZh(value: string): string {
  const parts = String(value ?? '')
    .split('/')
    .map((part) => part.trim())
    .map((part) =>
      part
        .replace(/\bweb3\b/gi, '')
        .replace(/\bweb\b/gi, '网页')
        .replace(/\binfra\b/gi, '基础设施')
        .replace(/\bdata\b/gi, '数据')
        .trim(),
    )
    .filter(Boolean)
  const unique = Array.from(new Set(parts))
  const joined = unique.join('与') || '通用'
  return joined.replace(/([A-Za-z0-9])(?=[\u4e00-\u9fff])/g, '$1 ')
}

export interface ChineseSummaryInput {
  name: string
  language: string | null
  categoryZh: string
  topics: string[]
  stack: string[]
  /** English description; its glossary terms are a second-priority source. */
  description?: string
}

/** Translations that only restate the implementation language already in the sentence. */
const LANGUAGE_TERMS = new Set(['类型化脚本', '脚本语言', '系统编程语言', '编程语言', '智能合约语言'])

/**
 * Build a Chinese-only positioning sentence from structured facts. The
 * repository name and language are proper nouns and stay as they are; every
 * other English word must come from (or be mapped through) the glossary.
 */
export function chineseSummary(input: ChineseSummaryInput): string {
  const name = String(input.name ?? '').trim()
  const language = input.language ? String(input.language).trim() : ''
  const category = pureCategoryZh(input.categoryZh)
  const categoryText = /^[A-Za-z]/.test(category) ? ` ${category}` : category
  const head = language
    ? `${name} 是一个用 ${language} 编写的${categoryText}类开源项目`
    : `${name} 是一个${categoryText}类开源项目`
  const terms: string[] = []
  const addTerm = (term: string) => {
    if (terms.length >= 3) return
    if (!term || term === language || LANGUAGE_TERMS.has(term)) return
    if (!terms.includes(term)) terms.push(term)
  }
  for (const term of translateTerms(input.topics ?? [])) addTerm(term)
  for (const term of descriptionTerms(input.description ?? '')) addTerm(term)
  for (const term of translateTerms(input.stack ?? [])) addTerm(term)
  if (terms.length === 0) return `${head}。`
  if (terms.length === 1) return `${head}，偏向${terms[0]}方向。`
  return `${head}，主要涉及${terms.join('、')}。`
}
