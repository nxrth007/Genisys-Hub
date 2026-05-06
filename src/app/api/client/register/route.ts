import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { sendEmail, getPublicOrigin } from '@/lib/gmail'

/**
 * POST /api/client/register
 *
 * Public endpoint (whitelisted in middleware). Step 1 of the client
 * self-onboarding flow:
 *   1. POST /api/client/register             ← creates User(client_pending)
 *   2. Auto-signin client-side               ← middleware bounces to step 3
 *   3. /signin/client/onboarding-form        ← business + contact details
 *   4. POST /api/client/onboarding-form      ← creates Client(lifecycle=pending)
 *   5. Admin reviews on /clients/onboarding  ← approve/deny
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

export async function POST(req: NextRequest) {
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
    select: { id: true, role: true },
  })

  if (!existing) {
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        role: 'client_pending',
      },
      select: { id: true, email: true, createdAt: true },
    })

    // Notify Alex that someone started signup. Onboarding-form
    // submission triggers a second email; this one's the heads-up
    // that a registration started so he can sanity-check it's not
    // spam. Best-effort — don't fail the request.
    try {
      const origin = getPublicOrigin(req)
      await sendEmail({
        accountEmail: FROM_GMAIL_ACCOUNT,
        to: ADMIN_NOTIFY_EMAIL,
        subject: `[Genisys Hub] New client registration started: ${email}`,
        body: [
          `**${email}** just started a client signup on the Hub.`,
          '',
          'They have not yet completed the onboarding form. You will get a second email when they finish — that is when their application appears on the Pending tab for approval.',
          '',
          `Started at: ${user.createdAt.toISOString()}`,
          `Hub: ${origin}/clients/onboarding`,
          '',
          'If this looks like spam, you can deny their application from the Pending tab once it lands there (or wait — they cannot reach anything until you approve).',
        ].join('\n'),
      })
    } catch (err) {
      console.error('[client/register] notify failed:', err)
    }
  } else {
    console.warn(
      `[client/register] duplicate email ${email} (role=${existing.role}) — returning generic OK`,
    )
  }

  // Generic OK regardless of branch. The auto-signin on the page
  // submits the same credentials; if the password didn't match an
  // existing account it will error there. We don't bake that into
  // the registration response itself.
  return NextResponse.json({ ok: true })
}
