/**
 * Provider-neutral LLM plumbing. Self-contained (no '@/' imports) so it can
 * be unit-tested without Next/Prisma.
 */
export type LlmProvider = 'anthropic' | 'openai' | 'xai'

export type LlmMessage = { role: 'user' | 'assistant'; content: string }

export type CompleteRequest = {
  system: string
  messages: LlmMessage[]
  maxTokens: number
  /** Ask for a JSON object; with a schema, adapters that support it enforce it. */
  json?: boolean | { schema: Record<string, unknown>; name?: string; strict?: boolean }
  signal?: AbortSignal
}

export type CompleteResult = {
  text: string
  /** 'end' | 'max_tokens' | 'refusal' | provider-specific string */
  stopReason: string
  model: string
  usage: { inputTokens: number; outputTokens: number }
}

export interface LlmClient {
  readonly provider: LlmProvider
  readonly model: string
  complete(req: CompleteRequest): Promise<CompleteResult>
}

/** Generic provider error carrying the HTTP status. */
export class LlmHttpError extends Error {
  constructor(
    readonly provider: LlmProvider,
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * The provider key is missing, refused, paused or out of credit. Never
 * retried: nothing changes until someone fixes the key in the Vault.
 */
export class LlmKeyBlockedError extends Error {
  readonly blocked = true
  constructor(
    readonly provider: LlmProvider,
    readonly reason: string,
  ) {
    super(`blocked: LLM key (${provider}) — ${reason}`)
  }
}

export function isKeyBlocked(err: unknown): err is LlmKeyBlockedError {
  return !!err && typeof err === 'object' && (err as { blocked?: unknown }).blocked === true
}

const BILLING = /billing|credit|quota|spend[_ ]limit|insufficient|payment|exhausted|paused|disabled/i

/**
 * Is this HTTP failure a key/account problem (blocked) rather than a
 * transient one? 401/403 always; 402 always; 429 only when the body says
 * it's about billing/quota (a plain rate limit is retryable).
 */
export function blockedReason(status: number, body: string): string | null {
  if (status === 401) return 'key refused (401)'
  if (status === 403) return 'key not permitted (403)'
  if (status === 402) return 'payment required / out of credit (402)'
  if (status === 429 && BILLING.test(body)) return 'quota or billing limit reached (429)'
  if (status === 400 && /credit balance|billing/i.test(body)) return 'out of credit (400)'
  return null
}
