import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * POST /api/client/change-password
 *
 * Lets a client_active user replace their password. Used by the
 * forced-first-login flow (admin-generated temp passwords flag the
 * user with mustChangePassword=true; middleware redirects to
 * /client/change-password until this endpoint clears the flag).
 *
 * Requires the current password as a re-auth check — even if a stale
 * session is hijacked, the attacker can't pivot to a new password
 * without knowing the temp one we emailed.
 */
const MIN_LENGTH = 10

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (session.user.role !== 'client_active') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    currentPassword?: unknown
    newPassword?: unknown
  }
  const currentPassword =
    typeof body.currentPassword === 'string' ? body.currentPassword : ''
  const newPassword =
    typeof body.newPassword === 'string' ? body.newPassword : ''

  if (!currentPassword || !newPassword) {
    return NextResponse.json(
      { error: 'currentPassword and newPassword are required' },
      { status: 400 },
    )
  }
  if (newPassword.length < MIN_LENGTH) {
    return NextResponse.json(
      { error: `Password must be at least ${MIN_LENGTH} characters.` },
      { status: 400 },
    )
  }
  if (newPassword === currentPassword) {
    return NextResponse.json(
      { error: 'New password must differ from the current password.' },
      { status: 400 },
    )
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, passwordHash: true },
  })
  if (!user || !user.passwordHash) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const ok = await bcrypt.compare(currentPassword, user.passwordHash)
  if (!ok) {
    return NextResponse.json(
      { error: 'Current password is incorrect.' },
      { status: 400 },
    )
  }

  const newHash = await bcrypt.hash(newPassword, 12)
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: newHash, mustChangePassword: false },
  })

  return NextResponse.json({ ok: true })
}
