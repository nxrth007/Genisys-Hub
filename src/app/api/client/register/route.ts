import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { sendEmail, getPublicOrigin } from '@/lib/gmail'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'

/**
 * POST /api/client/register
 *
 * Public endpoint (whitelisted in middleware). Step 1 of the client
 * self-onboarding funnel (revised 2026-05-11):
 *   1. POST /api/client/register             ← creates User(client_pending)
 *   2. Auto-signin → land on /client         ← polymorphic dashboard
 *   3. /client renders PrePayPlanPicker      ← name + plan + QB link
 *   4. POST /api/client/select-plan          ← creates Client(lifecycle=pending)
 *   5. Client pays via QuickBooks (out-of-band)
 *   6. Admin reviews on /clients/onboarding  ← approve/deny
 *   7. After approve, /client renders the onboarding form, then tracker
 *
 * Mirrors /api/agent/register's generic-response pattern: return 200
 * regardless of whether the email is new, already taken, or already a
 * staff/agent account. Lets us avoid leaking who's signed up while the
 * legitimate user just continues into the multi-step flow (or gets
 * routed to the right "wait/denied" screen by middleware on signin).
 */
const ADMIN_NOTIFY_EMAIL =
  process.env.CLIENT_ONBOARDING_NOTIFY_EMAIL ||
  process.env.AGENT_APPROVAL_NOTIFY_EMAIL ||
  'alex@leadgenisys.com'
const FROM_GMAIL_ACCOUNT =
  process.env.AGENT_APPROVAL_FROM_EMAIL || ADMIN_NOTIFY_EMAIL

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

/** Rate-limit window: 5 registrations per IP per 10 minutes. Tight
 *  enough to deter naive flooding, loose enough that a legit signup
 *  with a typo or two still gets through. Swap if abuse patterns
 *  change. */
const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000

export async function POST(req: NextRequest) {
  const ip = clientIp(req)
  const limit = checkRateLimit(
    `client-register:${ip}`,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
  )
  if (!limit.ok) {
    const retryAfterSeconds = Math.ceil(limit.retryAfterMs / 1000)
    return NextResponse.json(
      {
        error:
          'Too many registration attempts. Please try again in a few minutes.',
      },
      {
        status: 429,
        headers: { 'retry-after': String(retryAfterSeconds) },
      },
    )
  }

  let body: { email?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const email =
    typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const password = typeof body.password === 'string' ? body.password : ''

  if (!email || !isValidEmail(email)) {
    return NextResponse.json(
      { error: 'A valid email is required.' },
      { status: 400 },
    )
  }
  if (password.length < 10) {
    return NextResponse.json(
      { error: 'Password must be at least 10 characters.' },
      { status: 400 },
    )
  }

  // Hash up front so timing is similar across the new-vs-existing
  // branches. Lookup AFTER the hash, same shape as /api/agent/register.
  const passwordHash = await bcrypt.hash(password, 10)
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, role: true, clientId: true },
  })

  // Three branches:
  //   - new user                  → create as client_pending
  //   - orphaned mid-flow client  → reset back to client_pending and
  //                                 update password (they registered
  //                                 but never finished — or admin
  //                                 cleaned up the Client mid-flow)
  //   - any other existing user   → generic-skip (don't expose the
  //                                 collision; the auto-signin on
  //                                 the page surfaces a real error
  //                                 if the password doesn't match)
  //
  // Reset is INTENTIONALLY narrowed to client_pending /
  // client_onboarding (no completed application) — anyone who knows
  // the email could otherwise overwrite the password on a real
  // client_active or client_denied account that just had its Client
  // wiped. Those states need an admin to clean up explicitly; we
  // don't auto-reset them. Future improvement: token-link email
  // verification would let us safely reset any orphaned account.
  const isOrphanedClient =
    !!existing &&
    (existing.role === 'client_pending' ||
      existing.role === 'client_onboarding') &&
    !existing.clientId

  let createdOrReset: {
    id: string
    email: string
    createdAt: Date
    reset: boolean
  } | null = null

  if (!existing) {
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        role: 'client_pending',
      },
      select: { id: true, email: true, createdAt: true },
    })
    createdOrReset = { ...user, reset: false }
  } else if (isOrphanedClient) {
    // Reset path. Wipe `name` too so it doesn't carry over from a
    // prior business — the user might be re-registering for a
    // different one.
    const user = await prisma.user.update({
      where: { id: existing.id },
      data: {
        passwordHash,
        role: 'client_pending',
        clientId: null,
        name: null,
        mustChangePassword: false,
      },
      select: { id: true, email: true, createdAt: true },
    })
    createdOrReset = { ...user, reset: true }
  } else {
    console.warn(
      `[client/register] duplicate email ${email} (role=${existing.role}, clientId=${existing.clientId}) — returning generic OK without changes`,
    )
  }

  // Notify Alex on the new + reset branches. The reset path gets a
  // distinct subject so a second registration from a deleted client
  // doesn't look like a dupe alert. Fire-and-forget so the public
  // register endpoint doesn't sit on Gmail latency.
  if (createdOrReset) {
    const origin = getPublicOrigin(req)
    sendEmail({
      accountEmail: FROM_GMAIL_ACCOUNT,
      to: ADMIN_NOTIFY_EMAIL,
      subject: createdOrReset.reset
        ? `[Genisys Hub] Client re-registration started: ${email}`
        : `[Genisys Hub] New client registration started: ${email}`,
      body: [
        createdOrReset.reset
          ? `**${email}** just started signing up again. Their previous client record was deleted, so this is a fresh application.`
          : `**${email}** just started a client signup on the Hub.`,
        '',
        'They have only set a password so far — no business name, no plan picked, no payment. You will get a second email when they pick a plan and head to QuickBooks; that is when they land on the Pending tab ready for approval.',
        '',
        `Started at: ${createdOrReset.createdAt.toISOString()}`,
        `Hub: ${origin}/clients/onboarding`,
        '',
        'If this looks like spam, no action needed — they cannot reach anything until you approve, and abandoned signups never make it to the Pending tab.',
      ].join('\n'),
    }).catch((err) => {
      console.error('[client/register] notify failed:', err)
    })
  }

  // Generic OK regardless of branch. The auto-signin on the page
  // submits the same credentials; if the password didn't match an
  // existing account it will error there. We don't bake that into
  // the registration response itself.
  return NextResponse.json({ ok: true })
}
