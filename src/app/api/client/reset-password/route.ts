import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'

/**
 * POST /api/client/reset-password
 *
 * Public endpoint. Consumes the token sent by /api/client/forgot-password
 * and updates the user's password.
 *
 * The raw token is matched by:
 *   1. Find every client_* user with a non-expired passwordResetExpiresAt
 *   2. bcrypt.compare the submitted token against each tokenHash
 *   3. The match (if any) is the target user
 *
 * Bcrypt comparisons are slow by design, but at our scale (tiny
 * pool of pending resets, rate-limited) the worst case is a few
 * dozen comparisons. Acceptable.
 *
 * After a successful reset:
 *   - passwordHash is replaced
 *   - passwordResetTokenHash + passwordResetExpiresAt are cleared
 *   - mustChangePassword is cleared too (the reset itself is the
 *     intentional password choice; no need to force another)
 */
const MIN_LENGTH = 10
const RATE_LIMIT_MAX = 10
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000

export async function POST(req: NextRequest) {
  const ip = clientIp(req)
  const limit = checkRateLimit(
    `client-reset:${ip}`,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
  )
  if (!limit.ok) {
    const retryAfterSeconds = Math.ceil(limit.retryAfterMs / 1000)
    return NextResponse.json(
      { error: 'Too many attempts. Please try again in a few minutes.' },
      {
        status: 429,
        headers: { 'retry-after': String(retryAfterSeconds) },
      },
    )
  }

  let body: { token?: string; newPassword?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const token = typeof body.token === 'string' ? body.token : ''
  const newPassword =
    typeof body.newPassword === 'string' ? body.newPassword : ''

  if (!token) {
    return NextResponse.json(
      { error: 'Reset link is missing the token. Use the link from your email.' },
      { status: 400 },
    )
  }
  if (newPassword.length < MIN_LENGTH) {
    return NextResponse.json(
      { error: `Password must be at least ${MIN_LENGTH} characters.` },
      { status: 400 },
    )
  }

  // Pull every still-valid candidate. Hash comparisons happen
  // server-side so no enumeration via timing.
  const candidates = await prisma.user.findMany({
    where: {
      role: { startsWith: 'client_' },
      passwordResetTokenHash: { not: null },
      passwordResetExpiresAt: { gt: new Date() },
    },
    select: {
      id: true,
      passwordResetTokenHash: true,
    },
  })

  let matched: { id: string } | null = null
  for (const c of candidates) {
    if (!c.passwordResetTokenHash) continue
    const ok = await bcrypt.compare(token, c.passwordResetTokenHash)
    if (ok) {
      matched = { id: c.id }
      break
    }
  }

  if (!matched) {
    return NextResponse.json(
      {
        error:
          'This reset link is invalid or has expired. Request a new one from /signin/client/forgot-password.',
      },
      { status: 400 },
    )
  }

  const newHash = await bcrypt.hash(newPassword, 12)
  await prisma.user.update({
    where: { id: matched.id },
    data: {
      passwordHash: newHash,
      passwordResetTokenHash: null,
      passwordResetExpiresAt: null,
      // Reset is itself a password choice — clear the forced-first-
      // login flag too so the user lands on /client cleanly.
      mustChangePassword: false,
    },
  })

  return NextResponse.json({ ok: true })
}
