/**
 * Known AI model aliases matched against a repository's own text.
 *
 * The panel only shows model names that the repository itself mentions in its
 * name, description, topics or README excerpt — never a guess derived from the
 * category. The alias table below is the single maintenance point: add a model
 * family or version here and both the analysis and its test pick it up.
 */

/** Text evidence a card already has; nothing else is consulted. */
export interface AiModelEvidence {
  name: string
  description: string
  topics: string[]
  readmeSnippet: string | null
}

export interface AiModelAlias {
  /** Canonical name rendered on the card. */
  name: string
  /** Patterns that count as a mention of this model in the evidence text. */
  patterns: RegExp[]
}

/** Hard cap from the product requirement: at most three chips per card. */
export const MAX_AI_MODELS = 3

/**
 * Ordered alias table. Order is the display order, so version-specific entries
 * come before their broader family so "GPT-4o" never degrades to "GPT-4".
 * Patterns are word/boundary anchored to avoid matching inside longer words.
 */
export const AI_MODEL_ALIASES: AiModelAlias[] = [
  { name: 'GPT-4o', patterns: [/\bgpt[\s-]?4o\b/i] },
  { name: 'GPT-4', patterns: [/\bgpt[\s-]?4(?:\.\d+)?\b/i] },
  { name: 'GPT-3.5', patterns: [/\bgpt[\s-]?3\.5\b/i] },
  { name: 'GPT-3', patterns: [/\bgpt[\s-]?3\b/i] },
  { name: 'Claude', patterns: [/\bclaude\b/i] },
  { name: 'Gemini', patterns: [/\bgemini\b/i] },
  { name: 'Llama', patterns: [/\bllama\b/i] },
  { name: 'Mistral', patterns: [/\bmistral\b/i] },
  { name: 'Qwen', patterns: [/\bqwen\b/i] },
  { name: 'DeepSeek', patterns: [/\bdeepseek\b/i] },
  { name: 'Grok', patterns: [/\bgrok\b/i] },
  { name: 'Phi', patterns: [/\bphi[\s-]?\d\b/i] },
]

/**
 * Returns up to {@link MAX_AI_MODELS} model names that are literally present in
 * the repository's own text. Non-AI repositories always get an empty list, and
 * an AI repository with no model mention also gets an empty list: the category
 * alone is never enough evidence.
 */
export function detectAiModels(evidence: AiModelEvidence, isAi: boolean): string[] {
  if (!isAi) return []
  const text = [evidence.name, evidence.description, evidence.topics.join(' '), evidence.readmeSnippet ?? '']
    .join('\n')
    .trim()
  if (!text) return []
  const models: string[] = []
  for (const alias of AI_MODEL_ALIASES) {
    if (models.length >= MAX_AI_MODELS) break
    if (alias.patterns.some((pattern) => pattern.test(text))) models.push(alias.name)
  }
  return models
}
