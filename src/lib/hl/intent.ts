import Anthropic from '@anthropic-ai/sdk'
import { requireSecret } from '@/lib/seo/secrets'

/**
 * GHL's "Intent type" If/Else condition (AI): does the contact's reply say
 * yes to what the business texted them? GHL's options are "Positive/Yes"
 * (schedule-yes) and "Negative/No" (schedule-no). One short Claude call per
 * reply; the run keeps the answer, so a second check of the same reply
 * doesn't ask again.
 */

export type ReplyIntent = 'positive' | 'negative' | 'unclear'

/** Tests swap the classifier for a stub instead of calling Claude. */
export const intentHooks: { classify: ((reply: string, offer: string) => Promise<ReplyIntent | null>) | null } = { classify: null }

const SYSTEM = `You read one text message that a customer sent to a small home-services business, in reply to a text from the business, and decide what the customer means.

positive: they say yes, are interested, want it, or want to book, schedule or hear more.
negative: they say no, aren't interested, want to stop, or are annoyed.
unclear: anything else, such as a question, something unrelated, or a reply you can't read either way.`

const SCHEMA = {
  type: 'object',
  properties: { intent: { type: 'string', enum: ['positive', 'negative', 'unclear'] } },
  required: ['intent'],
  additionalProperties: false,
}

/** What the reply means; null when it couldn't be checked (no key, Claude unreachable, a refusal). */
export async function replyIntent(reply: string, offer: string): Promise<ReplyIntent | null> {
  const text = reply.trim()
  if (!text) return null
  if (intentHooks.classify) return intentHooks.classify(text, offer)
  try {
    const client = new Anthropic({
      apiKey: await requireSecret('anthropic'),
      // An ANTHROPIC_AUTH_TOKEN in the environment alongside a key is a 401.
      authToken: null,
      maxRetries: 2,
      timeout: 60_000,
    })
    const res = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 1024,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: `The business texted:\n${offer.trim() || '(not known)'}\n\nThe customer replied:\n${text}` }],
    })
    if (res.stop_reason === 'refusal') return null
    const out = res.content.find((b) => b.type === 'text')
    if (!out || out.type !== 'text') return null
    const intent = (JSON.parse(out.text) as { intent?: string }).intent
    return intent === 'positive' || intent === 'negative' || intent === 'unclear' ? intent : null
  } catch (err) {
    console.error('[hell-level] reply intent check failed:', err)
    return null
  }
}
