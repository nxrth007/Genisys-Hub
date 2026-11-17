import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'
import { hubAlertThrottled } from '@/lib/hub-alerts'
import { checkoutMember, emailMember, firstSecret, noteStripeStatus, STRIPE_KEY_ENTRIES, StripeUnavailable, VERIFY_KEY_ENTRIES } from '@/lib/stripe-onboarding'
import { CHECKOUT_SESSION_ID } from '@/lib/stripe-onboarding-plan'

/**
 * POST /api/public/checkout-verify — the onboarding form's question "may this
 * person onboard?" (clientonboarding.leadgenisys.com, repo
 * nxrth007/genisysclientonboarding, src/lib/checkout.server.ts).
 *
 * A client signs up at leadgenisys.com (Stripe Checkout: 30-day free trial of
 * $297/mo, card on file) and is sent to the form with ?session_id=cs_live_….
 *   { session_id }  → is that checkout complete with a trialing or active subscription?
 *   { email }       → a client who lost the link and confirmed this email instead:
 *                     does a customer with it have a trialing or active subscription?
 *
 * Header x-onboarding-key: the Vault's "Official Client Onboarding Verification
 * Key"; the form holds the same value (Lovable → Settings → Secrets →
 * HUB_VERIFICATION_KEY). Server to server, no CORS, rate-limited per caller.
 *
 * Answers the way the signup project's own verify-checkout-session does, so
 * the form treats both alike and asks that one when the Hub can't answer:
 *   200 { valid: true, email, name, subscription_status, trial_end, livemode }
 *   403 { valid: false }   not a member — the same for an unknown id, so ids can't be probed
 *   401 / 400              wrong password / bad input
 *   503                    the Vault entry is missing or Stripe didn't answer
 */

export const dynamic = 'force-dynamic'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export async function POST(req: NextRequest) {
  const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
  if (!checkRateLimit(`checkout-verify:${clientIp(req)}`, 60, 10 * 60_000).ok || !checkRateLimit('checkout-verify:all', 600, 60 * 60_000).ok) {
    return json({ valid: false, error: 'Too many requests' }, 429)
  }

  const expected = await firstSecret(VERIFY_KEY_ENTRIES)
  if (!expected) {
    await hubAlertThrottled(
      'checkout-verify:no_key',
      30 * 60_000,
      `:rotating_light: *The onboarding form asked the Hub to verify a sign-up, but the Vault has no "${VERIFY_KEY_ENTRIES[0]}"* — add it with the same value as the form's HUB_VERIFICATION_KEY. Until then the form asks the signup site's own verifier.`,
    )
    return json({ valid: false, error: 'Not configured' }, 503)
  }
  const provided = req.headers.get('x-onboarding-key') ?? ''
  if (!provided || !sameSecret(provided, expected.value)) {
    // A header that is there but wrong is a setup problem worth hearing about; scanners send none.
    if (provided) {
      void noteStripeStatus('verify', { at: new Date().toISOString(), outcome: 'unauthorized', asked: 'unknown' })
      await hubAlertThrottled(
        'checkout-verify:bad_key',
        30 * 60_000,
        `:rotating_light: *The onboarding form's password for the Hub doesn't match the Vault entry "${expected.name}"* — the form's HUB_VERIFICATION_KEY (Lovable → Settings → Secrets) must be the same value.`,
      )
    }
    return json({ valid: false, error: 'Unauthorized' }, 401)
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  const sessionId = isObj(body) && typeof body.session_id === 'string' ? body.session_id.trim() : ''
  const email = isObj(body) && typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!sessionId && !email) return json({ valid: false, error: 'session_id or email required' }, 400)
  if (sessionId && !CHECKOUT_SESSION_ID.test(sessionId)) return json({ valid: false, error: 'Invalid session_id' }, 400)
  if (!sessionId && !EMAIL.test(email)) return json({ valid: false, error: 'Invalid email' }, 400)

  const asked = sessionId ? 'session' : 'email'
  try {
    const m = sessionId ? await checkoutMember(sessionId) : await emailMember(email)
    if (!m.valid) {
      console.log(`[checkout-verify] ${sessionId || email}: not a member (${m.reason})`)
      void noteStripeStatus('verify', { at: new Date().toISOString(), outcome: 'not_member', asked })
      return json({ valid: false, error: 'Subscription not confirmed' }, 403)
    }
    console.log(`[checkout-verify] ${sessionId || email}: ${m.subscriptionStatus}${m.livemode ? '' : ' (test mode)'}`)
    void noteStripeStatus('verify', { at: new Date().toISOString(), outcome: 'ok', asked })
    return json({ valid: true, email: m.email, name: m.name, subscription_status: m.subscriptionStatus, trial_end: m.trialEnd, livemode: m.livemode })
  } catch (err) {
    if (err instanceof StripeUnavailable) {
      void noteStripeStatus('verify', { at: new Date().toISOString(), outcome: 'unavailable', asked })
      await hubAlertThrottled(
        'checkout-verify:stripe',
        30 * 60_000,
        `:warning: *The Hub couldn't ask Stripe about a sign-up* — ${err.message}. Check the Vault entry "${STRIPE_KEY_ENTRIES[0]}" (a restricted key with Checkout Sessions, Customers and Subscriptions read). The form falls back to the signup site's verifier meanwhile.`,
      )
      return json({ valid: false, error: 'Verification unavailable' }, 503)
    }
    console.error('[checkout-verify]', err)
    return json({ valid: false, error: 'Verification failed' }, 500)
  }
}

/** A GET is someone checking the URL is live. */
export function GET() {
  return NextResponse.json({ ok: true, endpoint: 'checkout-verify', accepts: 'POST { session_id | email } with x-onboarding-key' })
}
