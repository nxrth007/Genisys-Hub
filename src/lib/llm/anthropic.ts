import { blockedReason, LlmHttpError, LlmKeyBlockedError, type CompleteRequest, type CompleteResult, type LlmClient } from './types'

/** Minimal Anthropic Messages adapter over fetch (the SEO engine's rich path stays on the SDK in seo/claude.ts). */
export class AnthropicLlm implements LlmClient {
  readonly provider = 'anthropic' as const
  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly baseUrl = 'https://api.anthropic.com',
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {}

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages,
    }
    if (req.json && typeof req.json === 'object') {
      body.output_config = { format: { type: 'json_schema', schema: req.json.schema } }
    }
    const res = await this.fetchFn(`${this.baseUrl.replace(/\/+$/, '')}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: req.signal,
    })
    const raw = await res.text()
    if (!res.ok) {
      const blocked = blockedReason(res.status, raw)
      if (blocked) throw new LlmKeyBlockedError('anthropic', blocked)
      throw new LlmHttpError('anthropic', res.status, `Anthropic API ${res.status}`)
    }
    const j = JSON.parse(raw) as {
      model: string
      stop_reason: string
      content: { type: string; text?: string }[]
      usage: { input_tokens: number; output_tokens: number }
    }
    return {
      text: j.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(''),
      stopReason: j.stop_reason === 'end_turn' ? 'end' : j.stop_reason,
      model: j.model,
      usage: { inputTokens: j.usage?.input_tokens ?? 0, outputTokens: j.usage?.output_tokens ?? 0 },
    }
  }
}
