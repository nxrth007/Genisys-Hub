import { AnthropicLlm } from './anthropic'
import { OpenAiCompatibleLlm } from './openai'
import { LlmKeyBlockedError, type LlmClient, type LlmProvider } from './types'

export const DEFAULT_MODELS: Record<LlmProvider, string> = {
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-5-mini',
  xai: 'grok-4-fast',
}
export const BASE_URLS: Record<LlmProvider, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  xai: 'https://api.x.ai/v1',
}

/** Resolved settings (Vault first, then env), values never logged. */
export type LlmConfig = {
  provider: string | null
  model: string | null
  baseUrl: string | null
  keys: Partial<Record<LlmProvider, string | null>>
}

export type LlmSelection = { provider: LlmProvider; model: string | null; explicit: boolean }

export function parseProvider(v: string | null | undefined): LlmProvider | null {
  const s = v?.trim().toLowerCase()
  if (!s) return null
  if (s === 'anthropic' || s === 'claude') return 'anthropic'
  if (s === 'openai' || s === 'gpt') return 'openai'
  if (s === 'xai' || s === 'grok' || s === 'x.ai') return 'xai'
  return null
}

/**
 * Nothing set → anthropic (today's behavior, model from SEO settings).
 * 'LLM Provider' set → that provider, with 'LLM Model' or its default.
 */
export function selectProvider(cfg: LlmConfig): LlmSelection {
  const p = parseProvider(cfg.provider)
  if (!p) return { provider: 'anthropic', model: cfg.model?.trim() || null, explicit: false }
  return { provider: p, model: cfg.model?.trim() || (p === 'anthropic' ? null : DEFAULT_MODELS[p]), explicit: true }
}

export function buildClient(cfg: LlmConfig, fallbackModel: string, fetchFn?: typeof fetch): LlmClient {
  const sel = selectProvider(cfg)
  const key = cfg.keys[sel.provider]?.trim()
  if (!key) throw new LlmKeyBlockedError(sel.provider, `no ${sel.provider} API key in the Vault`)
  const model = sel.model ?? fallbackModel
  const base = cfg.baseUrl?.trim() || BASE_URLS[sel.provider]
  return sel.provider === 'anthropic' ? new AnthropicLlm(key, model, base, fetchFn) : new OpenAiCompatibleLlm(sel.provider, key, model, base, fetchFn)
}
