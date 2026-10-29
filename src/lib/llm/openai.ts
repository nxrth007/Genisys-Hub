import { blockedReason, LlmHttpError, LlmKeyBlockedError, type CompleteRequest, type CompleteResult, type LlmClient, type LlmProvider } from './types'

/** OpenAI-compatible Chat Completions adapter — OpenAI, xAI (Grok) or any compatible baseUrl. */
export class OpenAiCompatibleLlm implements LlmClient {
  constructor(
    readonly provider: Exclude<LlmProvider, 'anthropic'>,
    private readonly apiKey: string,
    readonly model: string,
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {}

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_completion_tokens: req.maxTokens,
      messages: [{ role: 'system', content: req.system }, ...req.messages],
    }
    if (req.json && typeof req.json === 'object') {
      body.response_format = { type: 'json_schema', json_schema: { name: req.json.name ?? 'result', strict: req.json.strict ?? false, schema: req.json.schema } }
    } else if (req.json) {
      body.response_format = { type: 'json_object' }
    }
    const res = await this.fetchFn(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: req.signal,
    })
    const raw = await res.text()
    if (!res.ok) {
      const blocked = blockedReason(res.status, raw)
      if (blocked) throw new LlmKeyBlockedError(this.provider, blocked)
      throw new LlmHttpError(this.provider, res.status, `${this.provider} API ${res.status}`)
    }
    const j = JSON.parse(raw) as {
      model?: string
      choices: { finish_reason: string; message: { content: string | null; refusal?: string | null } }[]
      usage?: { prompt_tokens: number; completion_tokens: number }
    }
    const c = j.choices?.[0]
    const stop = c?.message?.refusal ? 'refusal' : c?.finish_reason === 'length' ? 'max_tokens' : c?.finish_reason === 'stop' ? 'end' : (c?.finish_reason ?? 'end')
    return {
      text: c?.message?.content ?? '',
      stopReason: stop,
      model: j.model ?? this.model,
      usage: { inputTokens: j.usage?.prompt_tokens ?? 0, outputTokens: j.usage?.completion_tokens ?? 0 },
    }
  }
}
