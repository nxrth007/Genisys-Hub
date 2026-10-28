import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Whop webhook helpers with no Hub dependencies, so they can be unit-tested.
 *
 * Whop uses the Standard Webhooks spec (docs.whop.com/developer/guides/webhooks):
 * it HMAC-SHA256s `{webhook-id}.{webhook-timestamp}.{raw body}` and sends
 * `webhook-signature: v1,<base64>` (possibly several, space-separated). The
 * key is the UTF-8 bytes of the `ws_…` secret exactly as Whop shows it — this
 * matches @whop/sdk's unwrapWebhook, which base64s the raw secret before
 * handing it to `standardwebhooks` (which decodes it straight back).
 */

export const WHOP_TOLERANCE_SECONDS = 5 * 60

export type VerifyResult = { ok: true } | { ok: false; reason: string }

export function signWhopPayload(secret: string, id: string, timestamp: string, body: string): string {
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(`${id}.${timestamp}.${body}`).digest('base64')
}

export function verifyWhopSignature(opts: {
  secret: string
  body: string
  id: string | null
  timestamp: string | null
  signature: string | null
  nowSeconds?: number
  toleranceSeconds?: number
}): VerifyResult {
  const { secret, body, id, timestamp, signature } = opts
  if (!secret) return { ok: false, reason: 'no_secret' }
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing_headers' }
  if (!/^\d+$/.test(timestamp)) return { ok: false, reason: 'bad_timestamp' }
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000)
  const tolerance = opts.toleranceSeconds ?? WHOP_TOLERANCE_SECONDS
  if (Math.abs(now - Number(timestamp)) > tolerance) return { ok: false, reason: 'timestamp_out_of_range' }
  const expected = Buffer.from(signWhopPayload(secret, id, timestamp, body))
  for (const part of signature.split(' ')) {
    const [version, sig] = part.split(',', 2)
    if (version !== 'v1' || !sig) continue
    const given = Buffer.from(sig)
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true }
  }
  return { ok: false, reason: 'signature_mismatch' }
}

export type WhopSignup = {
  membershipId: string | null
  userId: string | null
  email: string | null
  name: string | null
  username: string | null
  phone: string | null
  businessName: string | null
  productTitle: string | null
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)
const first = (...vals: unknown[]): string | null => {
  for (const v of vals) {
    const x = s(v)
    if (x) return x
  }
  return null
}

/** Custom field answers as {normalized question → answer}; tolerates array or object shapes. */
function customAnswers(data: Obj): Record<string, string> {
  const out: Record<string, string> = {}
  const raw = data.custom_field_responses ?? data.custom_fields ?? data.customFieldResponses
  const key = (k: string) => k.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  if (Array.isArray(raw)) {
    for (const r of raw) {
      if (!isObj(r)) continue
      const q = first(r.question, r.name, r.label, r.key, isObj(r.custom_field) ? r.custom_field.name : null)
      const a = first(r.answer, r.value, r.response)
      if (q && a) out[key(q)] = a
    }
  } else if (isObj(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      const a = s(v)
      if (a) out[key(k)] = a
    }
  }
  return out
}

function pick(answers: Record<string, string>, test: (q: string) => boolean): string | null {
  for (const [q, a] of Object.entries(answers)) if (test(q)) return a
  return null
}

/** Pull the sign-up details out of a membership (or payment) event's `data`, whatever shape it has. */
export function extractWhopSignup(data: unknown): WhopSignup {
  const d: Obj = isObj(data) ? data : {}
  const user: Obj = isObj(d.user) ? d.user : isObj(d.member) && isObj(d.member.user) ? d.member.user : isObj(d.member) ? d.member : {}
  const membership: Obj = isObj(d.membership) ? d.membership : {}
  const product: Obj = isObj(d.product) ? d.product : isObj(membership.product) ? membership.product : {}
  const answers = { ...customAnswers(membership), ...customAnswers(d) }
  const isMembership = typeof d.id === 'string' && d.id.startsWith('mem_')
  return {
    membershipId: first(isMembership ? d.id : null, d.membership_id, membership.id),
    userId: first(user.id, d.user_id),
    email: first(user.email, d.email, d.user_email)?.toLowerCase() ?? null,
    username: first(user.username, d.username),
    name: first(pick(answers, (q) => /\b(full )?name\b/.test(q) && !/business|company/.test(q)), user.name, d.name),
    phone: first(pick(answers, (q) => /phone|mobile|cell/.test(q)), user.phone, d.phone),
    businessName: first(pick(answers, (q) => /business|company/.test(q))),
    productTitle: first(product.title, product.name),
  }
}

/** Keys-only sketch of a payload (no values), safe to log when a shape is unexpected. */
export function payloadShape(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return v.length ? [payloadShape(v[0], depth + 1)] : []
  if (!isObj(v)) return typeof v
  if (depth > 3) return '{…}'
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, payloadShape(x, depth + 1)]))
}
