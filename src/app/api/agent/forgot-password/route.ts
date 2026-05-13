import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { sendEmail, getPublicOrigin } from '@/lib/gmail'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'

/**
 * POST /api/agent/forgot-password
 *
 * Public endpoint. Initiates a password reset for an agent user
 * (Mary + future agents). Mirrors the client version exactly with
 * one role-narrow difference: only users whose role === 'agent' get
 * a reset email. Pending/denied agents can't reset their way in
 * (consistent with how they can't sign in at all).
 *
 * Staff (admin/member) use Google OAuth — no password to reset, so
 * they aren't a path here. The /signin staff page links to nothing
 * about resets because Google handles its own account recovery.
 *
 * Anti-enumeration: response is 200 regardless of whether the email
 * exists, matches an agent, or matches some other role. Token is
 * generated unconditionally so timing doesn't leak existence either.
 *
 * Rate-limited per IP (5 / 10min) — same window as the client and
 * register endpoints.
 */
const FROM_GMAIL_ACCOUNT =
  process.env.AGENT_APPROVAL_FROM_EMAIL || 'alex@leadgenisys.com'
const TOKEN_BYTES = 32
const TOKEN_TTL_MS = 60 * 60 * 1000 // 1 hour
const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req)
  const limit = checkRateLimit(
    `agent-forgot:${ip}`,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
  )
  if (!limit.ok) {
    const retryAfterSeconds = Math.ceil(limit.retryAfterMs / 1000)
    return NextResponse.json(
      { error: 'Too many requests. Please try again in a few minutes.' },
      {
        status: 429,
        headers: { 'retry-after': String(retryAfterSeconds) },
      },
    )
  }

  let body: { email?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const email =
    typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!email || !isValidEmail(email)) {
    return NextResponse.json(
      { error: 'A valid email is required.' },
      { status: 400 },
    )
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, role: true, name: true },
  })

  // Token generated unconditionally so response timing doesn't leak.
  const rawToken = randomBytes(TOKEN_BYTES).toString('base64url')
  const tokenHash = await bcrypt.hash(rawToken, 10)
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS)

  if (user && user.role === 'agent') {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetTokenHash: tokenHash,
        passwordResetExpiresAt: expiresAt,
      },
    })

    const origin = getPublicOrigin(req)
    const resetUrl = `${origin}/signin/agent/reset-password?token=${encodeURIComponent(rawToken)}`

    sendEmail({
      accountEmail: FROM_GMAIL_ACCOUNT,
      to: email,
      subject: 'Reset your Lead Genisys agent password',
      body: [
        `Hi ${user.name || 'there'},`,
        '',
        'You (or someone using this email) asked to reset the password for your Lead Genisys agent account. Click the link below to pick a new password:',
        '',
        `[Reset password →](${resetUrl})`,
        '',
        'This link expires in 1 hour. If you did not request this, you can safely ignore this email — your password will not change.',
        '',
        '— Lead Genisys',
      ].join('\n'),
    }).catch((err) => {
      console.error('[agent/forgot-password] email failed:', err)
    })
  } else if (user) {
    // Non-agent user (staff / pending agent / client) tried to reset
    // via the agent path. Log for ops visibility, return generic OK.
    // Pending agents can't reset because they shouldn't be holding a
    // password to begin with until approved.
    console.warn(
      `[agent/forgot-password] non-agent user ${email} (role=${user.role}) requested reset — ignoring`,
    )
  }

  return NextResponse.json({ ok: true })
}
