import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'

/**
 * POST /api/agent/reset-password
 *
 * Public endpoint. Consumes the token emailed by /api/agent/forgot-
 * password and updates the agent's password. Mirrors the client
 * reset endpoint exactly with a role narrow (agents only) — so a
 * stale token issued for a different role can't be redeemed here.
 *
 * Match strategy: pull all agents with non-expired reset tokens,
 * bcrypt.compare the submitted raw token against each hash. At our
 * scale the candidate set is single-digit.
 *
 * On success:
 *   - passwordHash replaced
 *   - passwordResetTokenHash + passwordResetExpiresAt cleared
 *   - mustChangePassword cleared (reset is itself an intentional
 *     password choice)
 */
const MIN_LENGTH = 10
const RATE_LIMIT_MAX = 10
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000

export async function POST(req: NextRequest) {
  const ip = clientIp(req)
  const limit = checkRateLimit(
    `agent-reset:${ip}`,
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

  const candidates = await prisma.user.findMany({
    where: {
      role: 'agent',
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
          'This reset link is invalid or has expired. Request a new one from /signin/agent/forgot-password.',
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
      mustChangePassword: false,
    },
  })

  return NextResponse.json({ ok: true })
}
