import { NextRequest, NextResponse, after } from 'next/server'
import { getSecretByName } from '@/lib/vault-service'
import { hubAlert, hubAlertThrottled, hubLink } from '@/lib/hub-alerts'
import { upsertContactByEmail } from '@/lib/ghl'
import { claimWhopSignup } from '@/lib/whop-signup-alerts'
import { textTeam, whopSignupText } from '@/lib/team-sms'
import { markTrackerStep } from '@/lib/onboarding-tracker'
import { extractWhopSignup, payloadShape, verifyWhopSignature, type WhopSignup } from '@/lib/whop-webhook'

/**
 * POST /api/webhooks/whop
 *
 * Whop calls this when a membership activates (register the URL in Whop's
 * Developer dashboard, event `membership.activated`). Signed per Standard
 * Webhooks; the secret is the Vault entry "Whop Webhook Secret" (env
 * WHOP_WEBHOOK_SECRET as a fallback). Never accepted in the query string.
 *
 * A valid event always gets a 200 straight away; the GHL upsert, team text
 * and tracker tick run afterwards (next/server `after`) so a slow or failing
 * GHL never makes Whop retry. Only a bad signature (401) or an unreadable
 * body (400) is refused.
 */

const SECRET_ENTRY = 'Whop Webhook Secret'
/** The Genisys GHL location new sign-ups land in. */
const GHL_VAULT_ENTRY = 'GHL Genisys Token'
const SIGNUP_TAG = 'whop-signup'
const HANDLED = new Set(['membership.activated'])
const ACKNOWLEDGED = new Set(['membership.updated', 'payment.succeeded'])

async function webhookSecret(): Promise<string | null> {
  try {
    const v = (await getSecretByName(SECRET_ENTRY)).trim()
    if (v) return v
  } catch {
    // fall through to env
  }
  return process.env.WHOP_WEBHOOK_SECRET?.trim() || null
}

export async function POST(req: NextRequest) {
  const raw = await req.text()
  const secret = await webhookSecret()
  if (!secret) {
    await hubAlertThrottled('whop-webhook:no_secret', 30 * 60_000, `:rotating_light: *Whop webhook got an event but has no secret* — add the Whop signing secret to the Hub vault as "${SECRET_ENTRY}".`)
    return NextResponse.json({ error: 'not_configured' }, { status: 503 })
  }

  const check = verifyWhopSignature({
    secret,
    body: raw,
    id: req.headers.get('webhook-id'),
    timestamp: req.headers.get('webhook-timestamp'),
    signature: req.headers.get('webhook-signature'),
  })
  if (!check.ok) {
    await hubAlertThrottled('whop-webhook:invalid_signature', 30 * 60_000, `:rotating_light: *Whop webhook rejected a request* (${check.reason}). If real sign-ups are failing, check the "${SECRET_ENTRY}" vault entry matches the secret in Whop's Developer dashboard.`)
    return NextResponse.json({ error: 'invalid_signature', reason: check.reason }, { status: 401 })
  }

  let event: { type?: unknown; data?: unknown }
  try {
    event = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const type = typeof event?.type === 'string' ? event.type : ''

  if (ACKNOWLEDGED.has(type)) return NextResponse.json({ ok: true, ignored: type })
  if (!HANDLED.has(type)) {
    console.log(`[whop-webhook] unhandled event type "${type}"; shape:`, JSON.stringify(payloadShape(event)))
    return NextResponse.json({ ok: true, ignored: type || 'unknown' })
  }

  const signup = extractWhopSignup(event.data)
  if (!signup.email || !signup.membershipId) {
    console.warn('[whop-webhook] membership.activated missing email or membership id; shape:', JSON.stringify(payloadShape(event)))
  }
  after(() => handleSignup(signup))
  return NextResponse.json({ ok: true })
}

async function handleSignup(m: WhopSignup) {
  const label = m.name ?? m.email ?? (m.username ? `@${m.username}` : m.membershipId ?? 'someone')

  if (m.email) {
    const [firstName, ...rest] = (m.name ?? '').split(/\s+/).filter(Boolean)
    try {
      const res = await upsertContactByEmail(GHL_VAULT_ENTRY, {
        email: m.email,
        phone: m.phone,
        firstName: firstName ?? m.username,
        lastName: rest.join(' ') || null,
        companyName: m.businessName,
        username: m.username,
        tags: [SIGNUP_TAG],
        customFields: {
          whop_membership_id: m.membershipId,
          whop_user_id: m.userId,
          whop_username: m.username,
          business_name: m.businessName,
        },
      })
      console.log(`[whop-webhook] ${m.membershipId}: GHL contact ${res.id} ${res.created ? 'created' : 'updated'}${res.skippedFields.length ? `; missing custom fields: ${res.skippedFields.join(', ')}` : ''}`)
    } catch (err) {
      console.error(`[whop-webhook] ${m.membershipId}: GHL upsert failed:`, err)
      await hubAlert(`:warning: *Whop sign-up didn't reach GHL* — ${label}. ${err instanceof Error ? err.message.slice(0, 300) : 'Unknown error'}`).catch(() => {})
    }
  } else {
    await hubAlert(`:warning: *Whop sign-up with no email* (${m.membershipId ?? 'no membership id'}) — not added to GHL.`).catch(() => {})
  }

  // Announce once, shared with the 5-minute poller in whop-signup-alerts.ts.
  if (!m.membershipId || process.env.NODE_ENV !== 'production') return
  try {
    if (!(await claimWhopSignup(m.membershipId))) return
    await textTeam(whopSignupText({ name: m.name, email: m.email, username: m.username, product: m.productTitle, price: null, link: hubLink('/payments') }), 'Whop sign-up')
    const tracked = await markTrackerStep('signup', { emails: [m.email], name: m.name, business: m.businessName }, { addIfMissing: true })
    if (!tracked.ok) console.warn(`[whop-webhook] tracker: ${tracked.detail}`)
  } catch (err) {
    console.error(`[whop-webhook] ${m.membershipId}: announce failed:`, err)
  }
}

/** A GET is someone checking the URL is live. */
export function GET() {
  return NextResponse.json({ ok: true, endpoint: 'whop-webhook', accepts: 'POST (Standard Webhooks signed)' })
}
