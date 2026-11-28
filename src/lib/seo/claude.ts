import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { requireSecret } from './secrets'
import { gatherEvidence } from './retrieval'
import type { ClaudeUsage, ResearchResult } from './types'

/**
 * Claude API plumbing for the SEO engine.
 *
 * Two providers can serve this engine, and the difference is not just the
 * base URL — it is which *services* exist behind it:
 *
 *  - `anthropic` hits api.anthropic.com and gets Claude's hosted server tools
 *    (`web_search_20260209`, `web_fetch_20260209`) plus enforced JSON-schema
 *    output. Research runs server-side; structured calls are decoded into the
 *    schema for us.
 *  - `mwapi` hits an Anthropic-compatible proxy that serves the MODEL ONLY.
 *    Hosted web search/fetch silently no-op there (the call returns 200 with
 *    no `server_tool_use` block, so the model answers from memory), and
 *    `output_config.format` is not enforced. So on this path research is done
 *    in-process by `retrieval.ts`, and structured output is obtained with a
 *    forced `tool_choice` tool call, which the proxy does honor.
 *
 * Every call goes through the beta Messages API so the anthropic path can
 * carry `fallbacks: 'default'`: if Opus's safety classifiers decline a request
 * (rare for contractor SEO, but "security headers" talk can trip the cyber
 * classifier), the API re-runs it on a fallback model inside the same call
 * instead of failing the week's run. Everything is streamed — research turns
 * and long posts run for minutes and would otherwise hit the SDK's
 * non-streaming guard.
 *
 * Research (web search/fetch) and structured output never share a call on the
 * anthropic path: web search always returns citations, and citations + a JSON
 * schema is a documented 400.
 */

export const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

/** Provider surface. `mwapi` = model only, no hosted tools, no schema enforcement. */
export type LlmProvider = 'anthropic' | 'mwapi'

/** MWAPI's Anthropic-compatible root. NO `/v1` — the SDK appends `/v1/messages`. */
const MWAPI_BASE_URL = 'https://api.mwapi.dev'

/** The tool the MWAPI path forces the model to call to produce structured output. */
const EMIT_TOOL = 'emit_result'


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
    readonly provider: LlmProvider = 'anthropic',
    /** Model to retry on when a safety classifier declines. Null = server handles it. */
    private readonly fallbackModel: string | null = null,
  ) {
    this.usage = { ...startingUsage }
  }

  static async open(o: {
    model: string
    budgetUsd: number
    usage?: ClaudeUsage | null
    provider?: LlmProvider
    fallbackModel?: string
  }): Promise<ClaudeSession> {
    const provider = o.provider ?? 'anthropic'
    const apiKey = provider === 'mwapi' ? await requireSecret('mwapi') : await requireSecret('anthropic')
    const client = new Anthropic({
      apiKey,
      // An ANTHROPIC_AUTH_TOKEN in the environment alongside a key is a 401.
      authToken: null,
      // Only override for MWAPI; undefined leaves the SDK on api.anthropic.com.
      baseURL: provider === 'mwapi' ? MWAPI_BASE_URL : undefined,
      maxRetries: 3,
      timeout: 15 * 60_000,
    })
    // The first-party API re-runs a declined request on a fallback model inside
    // the same call (`fallbacks: 'default'`). The proxy doesn't implement that
    // beta, so there we must do the retry ourselves — otherwise a classifier
    // decline fails the whole weekly run.
    const fallbackModel = provider === 'mwapi' ? (o.fallbackModel ?? 'claude-sonnet-5-5') : null
    return new ClaudeSession(client, o.model, o.budgetUsd, o.usage ?? emptyUsage(), provider, fallbackModel)
  }

  get spentUsd(): number {
    return this.usage.costUsd
  }

  private assertBudget(label: string) {
    // On MWAPI the per-token dollars are notional — the account is prepaid
    // subscription credits, so a "$8 cap" would abort runs over money nobody is
    // spending. The scarce resource there is tokens, and the absence of prompt
    // caching means every call re-sends the whole dossier. Cap that instead.
    if (this.provider === 'mwapi') {
      const tokenCap = Math.round(this.budgetUsd * 250_000)
      const used = this.usage.inputTokens + this.usage.outputTokens
      if (used >= tokenCap) {
        throw new BudgetExceededError(
          `Stopped before "${label}": this run has used ${used.toLocaleString()} of its ${tokenCap.toLocaleString()}-token allowance.`,
        )
      }
      return
    }
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
    /** Override the session model — used for the refusal retry. */
    model?: string,
  ): Promise<Anthropic.Beta.BetaMessage> {
    this.assertBudget(label)
    for (let attempt = 0; ; attempt++) {
      try {
        const message = await this.client.beta.messages
          .stream(
            { ...body, model: model ?? this.model, ...(this.provider === 'mwapi' ? {} : { betas: [FALLBACK_BETA], fallbacks: 'default' as const }) },
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
    // No hosted web tools on the proxy, so do the search and reading here.
    if (this.provider === 'mwapi') return this.researchViaRetrieval(o)
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

  /**
   * Research on a provider with no hosted web tools: plan queries, retrieve
   * evidence in-process, then have the model write the same prose digest the
   * hosted-tools path returns. Same return type, so the pipeline is unchanged.
   *
   * Three cheap steps instead of one expensive agentic one — and the model is
   * told to say when the evidence is thin, because the biggest failure mode of
   * a model without live search is confidently inventing last year's prices.
   */
  private async researchViaRetrieval(o: {
    label: string
    system: string
    context: string
    task: string
    location: { city: string | null; region: string | null; timezone: string | null }
    maxSearches: number
    maxFetches: number
  }): Promise<ResearchResult> {
    const toolErrors: string[] = []
    const place = o.location.city ? ` in ${o.location.city}${o.location.region ? `, ${o.location.region}` : ''}` : ''

    let queries: string[] = []
    try {
      const plan = await this.structured({
        label: `${o.label} (queries)`,
        system: 'You plan web research for a local SEO campaign. You return only search queries.',
        context: o.context,
        task:
          `${o.task}\n\n---\n` +
          `Write the ${Math.min(o.maxSearches, 10)} web search queries that would surface the most useful evidence for the above. ` +
          `Mix three kinds: (1) what a person types when shopping for this service${place}; ` +
          `(2) competitor and directory pages that currently rank for it; ` +
          `(3) authoritative or first-party sources with real figures — government, industry bodies, manufacturers. ` +
          `Each query is 3-8 words, no site: operators.`,
        schema: z.object({ queries: z.array(z.string().min(3).max(120)).min(1).max(10) }),
        effort: 'low',
        maxTokens: 4_000,
      })
      queries = plan.queries.map((q) => q.trim()).filter(Boolean)
    } catch (err) {
      toolErrors.push(`query planning failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Even with no plan, one broad query beats a wasted week.
    if (!queries.length) queries = [`best ${o.location.city ?? ''} local service providers`.trim()]

    const evidence = await gatherEvidence({
      queries,
      maxPages: Math.min(o.maxFetches, 10),
      location: { city: o.location.city, region: o.location.region },
      perQuery: 10,
    })
    toolErrors.push(...evidence.errors.slice(0, 8))
    // Retrieval happens in-process, so it has to be counted by hand or the run's
    // usage panel reports "0 web searches" and looks like research never ran.
    if (evidence.usedProvider) this.usage.webSearches += queries.length
    this.usage.webFetches += evidence.pages.length
    // A silent fallback to the keyless scraper looks like "research just got
    // worse"; say which provider actually answered so a mis-named Vault entry
    // is diagnosable from the run log.
    if (evidence.usedProvider === 'bing') {
      toolErrors.push('search fell back to the keyless Bing scraper (low fidelity) — check the Serper Vault entry name and key shape')
    }

    if (!evidence.pages.length) {
      return {
        digest: '(research unavailable this week — no pages could be retrieved, so rely on Search Console data and the existing posts)',
        sources: [],
        toolErrors,
      }
    }

    const pack = evidence.pages
      .map((p, i) => `### [${i + 1}] ${p.title || p.url}\nURL: ${p.url}\n\n${p.text.slice(0, 6_000)}`)
      .join('\n\n')

    const synthBody = {
      max_tokens: 16_000,
      thinking: { type: 'adaptive' as const, display: 'omitted' as const },
      output_config: { effort: 'high' as const },
      system: [{ type: 'text' as const, text: o.system, cache_control: { type: 'ephemeral' as const, ttl: '1h' as const } }],
      messages: [
        {
          role: 'user' as const,
          content: [
            { type: 'text' as const, text: o.context, cache_control: { type: 'ephemeral' as const, ttl: '1h' as const } },
            {
              type: 'text' as const,
              text:
                `${o.task}\n\n---\nEVIDENCE — pages retrieved from the live web during this run:\n\n${pack}\n\n---\n` +
                (evidence.questions.length
                  ? `QUESTIONS GOOGLE RETURNS FOR THESE SEARCHES (peopleAlsoAsk — real demand, not a model guess):\n` +
                    evidence.questions.map((q) => `- ${q}`).join('\n') +
                    `\n\n`
                  : '') +
                (evidence.related.length
                  ? `RELATED SEARCHES GOOGLE SUGGESTS:\n` +
                    evidence.related.map((q) => `- ${q}`).join('\n') +
                    `\n\n`
                  : '') +
                `---\nWrite the findings digest. Rules: state a fact only if it appears in the evidence above, and cite the page you took it from by its URL in brackets. ` +
                `Treat the question and related-search lists as evidence of real demand even where the fetched pages are thin — they come from Google itself. ` +
                `Where the evidence is silent or thin, say so plainly instead of filling the gap from memory. ` +
                `Give dollar figures, local specifics and competitor names only where the evidence supports them.`,
            },
          ],
        },
      ],
    }
    const m = await this.withRefusalRetry(`${o.label} (synthesis)`, synthBody)
    assertUsable(m)
    const digest = m.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
    return { digest, sources: evidence.sources, toolErrors }
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
    /** Images (by URL, each after its label) go between the context and the task. */
    images?: { label: string; url: string }[]
  }): Promise<T> {
    // The proxy doesn't enforce output_config.format, so decode through a
    // forced tool call there instead. Callers see no difference.
    if (this.provider === 'mwapi') return this.structuredViaTool(o)
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

  /**
   * Structured output on a provider without schema enforcement, via a forced
   * tool call. The proxy streams thinking blocks before the tool_use, so
   * `max_tokens` must cover the reasoning AND the payload — a small budget
   * truncates before the tool call ever appears.
   *
   * The proxy also doesn't *enforce* the tool's `input_schema`; it only
   * describes it. zod is therefore the real gate, and a shape miss is retried
   * with the validation issues fed back rather than failing the run.
   */
  private async structuredViaTool<T>(o: {
    label: string
    system: string
    context: string
    task: string
    schema: z.ZodType<T>
    effort: 'low' | 'medium' | 'high'
    maxTokens?: number
    /** Images (by URL, each after its label) go between the context and the task. */
    images?: { label: string; url: string }[]
  }): Promise<T> {
    // Upstream `structured()` accepts images by URL. Keep parity here, or the
    // MWAPI path would silently drop a site's photos that the Anthropic path sends.
    const images: Anthropic.Beta.BetaContentBlockParam[] = (o.images ?? []).flatMap((img) => [
      { type: 'text' as const, text: img.label },
      { type: 'image' as const, source: { type: 'url' as const, url: img.url } },
    ])
    let lastIssue = ''
    for (let attempt = 0; attempt < 3; attempt++) {
      const task =
        attempt === 0
          ? o.task
          : `${o.task}\n\n---\nYour previous answer was rejected: ${lastIssue}\nReturn the corrected object through the ${EMIT_TOOL} tool. Include every required field.`
      const body = {
        max_tokens: o.maxTokens ?? 32_000,
        thinking: { type: 'adaptive' as const, display: 'omitted' as const },
        output_config: { effort: o.effort },
        system: [{ type: 'text' as const, text: o.system, cache_control: { type: 'ephemeral' as const, ttl: '1h' as const } }],
        // The schema is generated, so its `type: 'object'` is `string` at the
        // type level while the SDK wants the literal. Cast at the boundary.
        tools: [
          {
            name: EMIT_TOOL,
            description: 'Return the finished result. Call this exactly once.',
            input_schema: structuredSchema(o.schema),
          } as unknown as Anthropic.Beta.BetaToolUnion,
        ],
        tool_choice: { type: 'tool' as const, name: EMIT_TOOL },
        messages: [
          {
            role: 'user' as const,
            content: [
              { type: 'text' as const, text: o.context, cache_control: { type: 'ephemeral' as const, ttl: '1h' as const } },
              ...images,
              { type: 'text' as const, text: task },
            ],
          },
        ],
      }
      const m = await this.withRefusalRetry(attempt === 0 ? o.label : `${o.label} (retry ${attempt})`, body)
      assertUsable(m)
      const block = m.content.find((b) => b.type === 'tool_use' && b.name === EMIT_TOOL)
      if (!block || block.type !== 'tool_use') {
        lastIssue = 'the response contained no tool call (the answer may have been cut off)'
        continue
      }
      // A proxy may hand the arguments back as a JSON string instead of an object.
      let input: unknown = block.input
      if (typeof input === 'string') {
        try {
          input = JSON.parse(input)
        } catch {
          lastIssue = 'the tool arguments were not valid JSON'
          continue
        }
      }
      const parsed = o.schema.safeParse(input)
      if (parsed.success) return parsed.data
      lastIssue = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')
    }
    throw new Error(`Claude returned output that doesn't match the expected shape (${lastIssue}).`)
  }

  /**
   * A safety-classifier decline is not a content bug — the first-party API
   * re-runs such a request on a fallback model inside the same call. The proxy
   * doesn't implement that beta, and `engine.ts` treats a refusal with no
   * `recommendedModel` as fatal, so without this retry a single declined
   * paragraph would kill the whole week's run.
   */
  private async withRefusalRetry(
    label: string,
    body: Omit<Anthropic.Beta.MessageCreateParamsNonStreaming, 'model' | 'betas' | 'fallbacks' | 'stream'>,
  ): Promise<Anthropic.Beta.BetaMessage> {
    try {
      const m = await this.stream(label, body)
      assertUsable(m)
      return m
    } catch (err) {
      if (!(err instanceof RefusalError) || !this.fallbackModel) throw err
      const m = await this.stream(`${label} → ${this.fallbackModel}`, body, this.fallbackModel)
      assertUsable(m)
      return m
    }
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
