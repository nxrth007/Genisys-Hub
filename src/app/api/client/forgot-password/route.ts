import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { sendEmail, getPublicOrigin } from '@/lib/gmail'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'

/**
 * POST /api/client/forgot-password
 *
 * Public endpoint. Initiates a password reset for a client_* user:
 *   1. Generate a random 32-byte token
 *   2. Bcrypt-hash it (raw token only ever in the email link)
 *   3. Store hash + 1h expiry on the User row
 *   4. Email the link `/signin/client/reset-password?token=<raw>`
 *   5. Return generic OK regardless of whether the email exists
 *      (don't leak account enumeration)
 *
 * Hard-narrowed to client_* roles so the same endpoint can't be used
 * to phish staff into a reset email they didn't request — agents
 * and admin/member don't have a self-serve reset on this surface.
 *
 * Rate-limited per IP (5 / 10min) — same window as the register
 * endpoints. A token-flooding attacker would still face the bcrypt
 * cost on every reset attempt anyway.
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
    `client-forgot:${ip}`,
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

  // Generate the token unconditionally so the response timing for
  // existing-vs-new emails is similar. Only persist + email if the
  // user is actually a client. Same anti-enumeration posture as the
  // /api/client/register endpoint.
  const rawToken = randomBytes(TOKEN_BYTES).toString('base64url')
  const tokenHash = await bcrypt.hash(rawToken, 10)
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS)

  if (user && user.role.startsWith('client_')) {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetTokenHash: tokenHash,
        passwordResetExpiresAt: expiresAt,
      },
    })

    // Build the reset URL using the request origin so test deploys
    // generate links pointing at themselves rather than production.
    const origin = getPublicOrigin(req)
    const resetUrl = `${origin}/signin/client/reset-password?token=${encodeURIComponent(rawToken)}`

    sendEmail({
      accountEmail: FROM_GMAIL_ACCOUNT,
      to: email,
      subject: 'Reset your Lead Genisys password',
      body: [
        `Hi ${user.name || 'there'},`,
        '',
        'You (or someone using this email) asked to reset the password for your Lead Genisys account. Click the link below to pick a new password:',
        '',
        `[Reset password →](${resetUrl})`,
        '',
        'This link expires in 1 hour. If you did not request this, you can safely ignore this email — your password will not change.',
        '',
        '— Lead Genisys',
      ].join('\n'),
    }).catch((err) => {
      console.error('[client/forgot-password] email failed:', err)
    })
  } else if (user) {
    // Non-client user (staff/agent) tried to reset. Log for ops
    // visibility, return generic OK.
    console.warn(
      `[client/forgot-password] non-client user ${email} (role=${user.role}) requested reset — ignoring`,
    )
  }

  return NextResponse.json({ ok: true })
}
