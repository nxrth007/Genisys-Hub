import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { requireSecret } from './secrets'
import type { ClaudeUsage, ResearchResult } from './types'

/**
 * Claude API plumbing for the SEO engine.
 *
 * Every call goes through the beta Messages API so it can carry
 * `fallbacks: 'default'`: if Opus's safety classifiers decline a request
 * (rare for contractor SEO, but "security headers" talk can trip the cyber
 * classifier), the API re-runs it on a fallback model inside the same call
 * instead of failing the week's run. Everything is streamed — research
 * turns and long posts run for minutes and would otherwise hit the SDK's
 * non-streaming guard.
 *
 * Research (web search/fetch) and structured output never share a call:
 * web search always returns citations, and citations + a JSON schema is a
 * documented 400. Research returns prose with sources; a separate call
 * turns that into schema-valid JSON.
 */

export const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

/** Per-MTok prices; the fallback model bills at its own (equal) rate. */
const PRICES: Record<string, { in: number; out: number; w5m: number; w1h: number; read: number }> = {
  'claude-opus-5': { in: 5, out: 25, w5m: 6.25, w1h: 10, read: 0.5 },
  'claude-opus-5-5': { in: 4, out: 20, w5m: 5, w1h: 8, read: 0.2 },
  'claude-opus-4-8': { in: 5, out: 25, w5m: 6.25, w1h: 10, read: 0.5 },
  'claude-fable-5-1': { in: 10, out: 50, w5m: 12.5, w1h: 20, read: 0.25 },
  'claude-sonnet-5': { in: 2, out: 10, w5m: 2.5, w1h: 4, read: 0.2 },
}
const WEB_SEARCH_USD = 0.01

export class RefusalError extends Error {
  constructor(
    readonly category: string | null,
    readonly explanation: string | null,
    /** Set when the fallback couldn't run (capacity), so a later retry can succeed. */
    readonly recommendedModel: string | null = null,
  ) {
    super(`Claude declined this request${category ? ` (${category})` : ''}${explanation ? `: ${explanation}` : ''}.`)
  }
}
export class TruncatedError extends Error {}
/** Not worth retrying: bad key, bad request, spend cap, budget exhausted. */
export class FatalClaudeError extends Error {}
export class BudgetExceededError extends FatalClaudeError {}

export function emptyUsage(): ClaudeUsage {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0, webFetches: 0, costUsd: 0 }
}

/**
 * One run's Claude session: the client, the model, a running usage total
 * and a hard dollar ceiling checked before every call.
 */
export class ClaudeSession {
  readonly usage: ClaudeUsage

  private constructor(
    private readonly client: Anthropic,
    readonly model: string,
    private readonly budgetUsd: number,
    startingUsage: ClaudeUsage,
  ) {
    this.usage = { ...startingUsage }
  }

  static async open(o: { model: string; budgetUsd: number; usage?: ClaudeUsage | null }): Promise<ClaudeSession> {
    const client = new Anthropic({
      apiKey: await requireSecret('anthropic'),
      // An ANTHROPIC_AUTH_TOKEN in the environment alongside a key is a 401.
      authToken: null,
      maxRetries: 3,
      timeout: 15 * 60_000,
    })
    return new ClaudeSession(client, o.model, o.budgetUsd, o.usage ?? emptyUsage())
  }

  get spentUsd(): number {
    return this.usage.costUsd
  }

  private assertBudget(label: string) {
    if (this.usage.costUsd >= this.budgetUsd) {
      throw new BudgetExceededError(
        `Stopped before "${label}": this run has spent $${this.usage.costUsd.toFixed(2)} of its $${this.budgetUsd.toFixed(2)} cap.`,
      )
    }
  }

  private record(m: Anthropic.Beta.BetaMessage) {
    const u = m.usage
    const p = PRICES[m.model] ?? PRICES[this.model] ?? PRICES['claude-opus-5']
    const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
    // In a stream the TTL breakdown is the message_start snapshot, but the
    // cumulative total also counts the 5-minute writes web tools insert
    // after each result — price the difference as 5-minute writes.
    const w5m = Math.max(0, (u.cache_creation_input_tokens ?? 0) - w1h)
    const read = u.cache_read_input_tokens ?? 0
    const searches = u.server_tool_use?.web_search_requests ?? 0
    const cost =
      (u.input_tokens * p.in + w5m * p.w5m + w1h * p.w1h + read * p.read + u.output_tokens * p.out) / 1e6 +
      searches * WEB_SEARCH_USD
    this.usage.calls += 1
    this.usage.inputTokens += u.input_tokens
    this.usage.outputTokens += u.output_tokens
    this.usage.cacheReadTokens += read
    this.usage.cacheWriteTokens += w5m + w1h
    this.usage.webSearches += searches
    this.usage.webFetches += u.server_tool_use?.web_fetch_requests ?? 0
    this.usage.costUsd = Math.round((this.usage.costUsd + cost) * 10_000) / 10_000
  }

  /** One streamed request with fallbacks, our own retry on mid-stream errors, and usage accounting. */
  private async stream(
    label: string,
    body: Omit<Anthropic.Beta.MessageCreateParamsNonStreaming, 'model' | 'betas' | 'fallbacks' | 'stream'>,
  ): Promise<Anthropic.Beta.BetaMessage> {
    this.assertBudget(label)
    for (let attempt = 0; ; attempt++) {
      try {
        const message = await this.client.beta.messages
          .stream(
            { ...body, model: this.model, betas: [FALLBACK_BETA], fallbacks: 'default' },
            // Wall-clock cap per call; streams aren't bounded by the SDK timeout once headers arrive.
            { signal: AbortSignal.timeout(25 * 60_000) },
          )
          .finalMessage()
        this.record(message)
        return message
      } catch (err) {
        if (!(err instanceof Anthropic.APIError) || err instanceof Anthropic.APIUserAbortError) throw err
        if (
          err instanceof Anthropic.AuthenticationError ||
          err instanceof Anthropic.PermissionDeniedError ||
          err instanceof Anthropic.NotFoundError ||
          err instanceof Anthropic.BadRequestError ||
          err.status === 402 ||
          err.status === 413
        ) {
          throw new FatalClaudeError(`Claude API (${label}): ${err.status} ${err.message}`)
        }
        const details = (err.error as { error?: { details?: { error_code?: string } } } | undefined)?.error?.details
        if (err instanceof Anthropic.RateLimitError && details?.error_code === 'enforced_spend_limit_reached') {
          throw new FatalClaudeError('The Anthropic account hit its monthly spend limit.')
        }
        const retryable =
          err instanceof Anthropic.RateLimitError ||
          err instanceof Anthropic.InternalServerError ||
          err instanceof Anthropic.APIConnectionError ||
          // An error event mid-stream: no status, the SDK won't retry it.
          (err.status === undefined && (err.type === 'overloaded_error' || err.type === 'api_error'))
        if (!retryable || attempt >= 2) throw err
        await new Promise((r) => setTimeout(r, Math.min(60_000, 5_000 * 2 ** attempt)))
      }
    }
  }

  /**
   * Research turn(s) with web search + fetch. Returns prose findings with
   * the sources flattened to plain text, ready to feed a structured call.
   */
  async research(o: {
    label: string
    system: string
    /** Stable, cacheable context (site dossier). */
    context: string
    /** The per-run instruction; must contain any URL web_fetch should be allowed to open. */
    task: string
    location: { city: string | null; region: string | null; timezone: string | null }
    maxSearches: number
    maxFetches: number
  }): Promise<ResearchResult> {
    const tools: Anthropic.Beta.BetaToolUnion[] = [
      {
        type: 'web_search_20260209',
        name: 'web_search',
        max_uses: o.maxSearches,
        user_location: {
          type: 'approximate',
          city: o.location.city,
          region: o.location.region,
          country: 'US',
          timezone: o.location.timezone,
        },
      },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: o.maxFetches, max_content_tokens: 20_000 },
    ]
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: o.context, cache_control: { type: 'ephemeral', ttl: '1h' } },
          { type: 'text', text: o.task },
        ],
      },
    ]
    const blocks: Anthropic.Beta.BetaContentBlock[] = []
    let finished = false
    // pause_turn: the server paused a long tool loop; resend the transcript to continue it.
    for (let i = 0; i < 6; i++) {
      const m = await this.stream(`${o.label} #${i + 1}`, {
        max_tokens: 32_000,
        thinking: { type: 'adaptive', display: 'omitted' },
        output_config: { effort: 'high' },
        system: [{ type: 'text', text: o.system, cache_control: { type: 'ephemeral', ttl: '1h' } }],
        tools,
        messages,
      })
      blocks.push(...m.content)
      messages.push({ role: 'assistant', content: echoable(m.content) })
      if (m.stop_reason === 'pause_turn') continue
      assertUsable(m)
      finished = true
      break
    }
    const result = collectResearch(blocks)
    if (!finished) result.toolErrors.push('research stopped after 6 continuations — notes may be incomplete')
    return result
  }

  /** A schema-constrained answer, validated with zod. No tools. */
  async structured<T>(o: {
    label: string
    system: string
    context: string
    task: string
    schema: z.ZodType<T>
    effort: 'low' | 'medium' | 'high'
    maxTokens?: number
  }): Promise<T> {
    const format = { type: 'json_schema' as const, schema: structuredSchema(o.schema) }
    const m = await this.stream(o.label, {
      max_tokens: o.maxTokens ?? 32_000,
      thinking: { type: 'adaptive', display: 'omitted' },
      output_config: { effort: o.effort, format },
      system: [{ type: 'text', text: o.system, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: o.context, cache_control: { type: 'ephemeral', ttl: '1h' } },
            { type: 'text', text: o.task },
          ],
        },
      ],
    })
    assertUsable(m)
    return parseStructured(m, o.schema)
  }
}

function assertUsable(m: Anthropic.Beta.BetaMessage) {
  if (m.stop_reason === 'refusal') {
    throw new RefusalError(m.stop_details?.category ?? null, m.stop_details?.explanation ?? null, m.stop_details?.recommended_model ?? null)
  }
  if (m.stop_reason === 'max_tokens' || m.stop_reason === 'model_context_window_exceeded') {
    throw new TruncatedError(`Claude's answer was cut off (${m.stop_reason}).`)
  }
}

/**
 * After a mid-output fallback, blocks before the last fallback marker that
 * belong to the declined model (thinking, unpaired tool calls) must not be
 * echoed back.
 */
function echoable(content: Anthropic.Beta.BetaContentBlock[]): Anthropic.Beta.BetaContentBlock[] {
  let boundary = -1
  content.forEach((b, i) => {
    if (b.type === 'fallback') boundary = i
  })
  if (boundary < 0) return content
  const paired = new Set<string>()
  for (const b of content) {
    if ((b.type === 'web_search_tool_result' || b.type === 'web_fetch_tool_result') && 'tool_use_id' in b) {
      paired.add(b.tool_use_id)
    }
  }
  return content.filter((b, i) => {
    if (i >= boundary) return true
    if (b.type === 'text' || b.type === 'web_search_tool_result' || b.type === 'web_fetch_tool_result') return true
    if (b.type === 'server_tool_use') return paired.has(b.id)
    return false
  })
}

function collectResearch(blocks: Anthropic.Beta.BetaContentBlock[]): ResearchResult {
  const sources = new Map<string, string>()
  const toolErrors: string[] = []
  let digest = ''
  for (const b of blocks) {
    if (b.type === 'text') {
      digest += b.text
      const cited = new Set<string>()
      for (const c of b.citations ?? []) {
        if (c.type === 'web_search_result_location' && !cited.has(c.url)) {
          cited.add(c.url)
          sources.set(c.url, c.title ?? c.url)
        }
      }
      // Citations become plain-text source markers the structured call can read.
      if (cited.size) digest += ` [sources: ${[...cited].join(', ')}]`
    } else if (b.type === 'web_search_tool_result') {
      if (Array.isArray(b.content)) {
        for (const r of b.content) if (!sources.has(r.url)) sources.set(r.url, r.title)
      } else {
        toolErrors.push(`web_search: ${b.content.error_code}`)
      }
    } else if (b.type === 'web_fetch_tool_result') {
      if (b.content.type === 'web_fetch_tool_result_error') toolErrors.push(`web_fetch: ${b.content.error_code}`)
      else if ('url' in b.content && typeof b.content.url === 'string') sources.set(b.content.url, b.content.url)
    }
  }
  return {
    digest: digest.trim(),
    sources: [...sources.entries()].slice(0, 60).map(([url, title]) => ({ url, title })),
    toolErrors,
  }
}

/**
 * The JSON schema sent as `output_config.format`. zod's own export keeps
 * `enum`/`const` (which structured outputs enforce during decoding — the
 * SDK's helper demotes them to descriptions); everything outside the
 * supported keyword set is dropped and every object is closed.
 */
const SCHEMA_KEYS = new Set(['type', 'properties', 'required', 'items', 'enum', 'const', 'anyOf', 'allOf', '$ref', '$defs', 'description', 'format'])
function strict(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strict)
  if (!node || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (!SCHEMA_KEYS.has(k)) continue
    out[k] =
      k === 'properties' || k === '$defs'
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, strict(pv)]))
        : strict(v)
  }
  if (out.type === 'object') out.additionalProperties = false
  return out
}
const schemaCache = new WeakMap<z.ZodType, Record<string, unknown>>()
export function structuredSchema(schema: z.ZodType): Record<string, unknown> {
  let s = schemaCache.get(schema)
  if (!s) {
    s = strict(z.toJSONSchema(schema, { io: 'input', reused: 'inline' })) as Record<string, unknown>
    schemaCache.set(schema, s)
  }
  return s
}

function parseStructured<T>(m: Anthropic.Beta.BetaMessage, schema: z.ZodType<T>): T {
  const text = (bs: Anthropic.Beta.BetaContentBlock[]) =>
    bs
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
  let lastFallback = -1
  m.content.forEach((b, i) => {
    if (b.type === 'fallback') lastFallback = i
  })
  const candidates = [text(m.content)]
  // A fallback model continues from the declined model's partial text; if
  // the join isn't valid JSON, the part after the marker may be.
  if (lastFallback >= 0) candidates.push(text(m.content.slice(lastFallback + 1)))
  let lastIssue = 'no text in response'
  for (const raw of candidates) {
    try {
      const parsed = schema.safeParse(JSON.parse(raw))
      if (parsed.success) return parsed.data
      lastIssue = parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')
    } catch (err) {
      lastIssue = err instanceof Error ? err.message : 'invalid JSON'
    }
  }
  throw new Error(`Claude returned output that doesn't match the expected shape (${lastIssue}).`)
}
