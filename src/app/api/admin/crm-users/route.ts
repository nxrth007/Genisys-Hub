import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { requireAdmin } from '@/lib/auth-helpers'
import {
  CRM_DENIED,
  CRM_PENDING,
  CRM_USER,
  STAFF_ROLES,
  passwordProblem,
} from '@/lib/external-auth'

/**
 * Admin management of CRM frontend accounts.
 *
 * Approving is what actually grants access to real client data, so this
 * is admin-only and every state change is explicit.
 */

const CRM_ROLES = [CRM_PENDING, CRM_USER, CRM_DENIED]

export async function GET() {
  const denial = await requireAdmin()
  if (denial) return denial

  const users = await prisma.user.findMany({
    where: { role: { in: [...CRM_ROLES, ...STAFF_ROLES] } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      approvedAt: true,
      createdAt: true,
      passwordHash: true,
    },
  })

  // Live sessions, so an admin can see who currently holds access.
  const sessions = await prisma.apiToken.groupBy({
    by: ['createdById'],
    where: { scope: 'session', revokedAt: null },
    _count: { _all: true },
    _max: { lastUsedAt: true },
  })
  const byUser = new Map(
    sessions.map((s) => [
      s.createdById ?? '',
      { count: s._count._all, lastUsedAt: s._max.lastUsedAt },
    ]),
  )

  return NextResponse.json({
    ok: true,
    users: users.map(({ passwordHash, ...u }) => ({
      ...u,
      // Never leak the hash — just whether a password exists at all.
      hasPassword: !!passwordHash,
      isStaff: STAFF_ROLES.includes(u.role),
      activeSessions: byUser.get(u.id)?.count ?? 0,
      lastSeenAt: byUser.get(u.id)?.lastUsedAt ?? null,
    })),
  })
}

export async function POST(req: NextRequest) {
  const denial = await requireAdmin()
  if (denial) return denial

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const action = String(body.action ?? '')
  const id = String(body.id ?? '')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const target = await prisma.user.findUnique({ where: { id } })
  if (!target || ![...CRM_ROLES, ...STAFF_ROLES].includes(target.role)) {
    return NextResponse.json({ error: 'Unknown account.' }, { status: 404 })
  }

  // Role changes are for CRM accounts only. Applying approve/deny to a
  // staff member would overwrite admin/member and lock them out of the
  // Hub — `role` is a single column, so there is no "add a role".
  const roleChanging = ['approve', 'deny', 'revoke'].includes(action)
  if (roleChanging && STAFF_ROLES.includes(target.role)) {
    return NextResponse.json(
      {
        error:
          'This is a Hub staff account. Changing its role here would revoke their Hub access — manage staff roles in the Hub instead.',
      },
      { status: 400 },
    )
  }

  const session = await auth()
  const adminId = (session?.user as { id?: string } | undefined)?.id ?? null

  /** Kill every live session for a user — used whenever access is removed. */
  const revokeSessions = () =>
    prisma.apiToken.updateMany({
      where: { createdById: id, scope: 'session', revokedAt: null },
      data: { revokedAt: new Date() },
    })

  if (action === 'approve') {
    await prisma.user.update({
      where: { id },
      data: { role: CRM_USER, approvedAt: new Date(), approvedById: adminId },
    })
    return NextResponse.json({
      ok: true,
      message: `${target.email} can now sign in.`,
    })
  }

  if (action === 'deny' || action === 'revoke') {
    await prisma.user.update({ where: { id }, data: { role: CRM_DENIED } })
    // Access removed means access removed now, not when the token expires.
    await revokeSessions()
    return NextResponse.json({
      ok: true,
      message: `${target.email} no longer has access and was signed out.`,
    })
  }

  if (action === 'signOut') {
    await revokeSessions()
    return NextResponse.json({
      ok: true,
      message: `Signed ${target.email} out of all devices.`,
    })
  }

  if (action === 'setPassword') {
    const password = String(body.password ?? '')
    const problem = passwordProblem(password)
    if (problem) return NextResponse.json({ error: problem }, { status: 400 })
    await prisma.user.update({
      where: { id },
      data: { passwordHash: await bcrypt.hash(password, 12) },
    })
    await revokeSessions()
    return NextResponse.json({
      ok: true,
      message: `Password reset for ${target.email}. Existing sessions were ended.`,
    })
  }

  return NextResponse.json({ error: `Unknown action "${action}"` }, { status: 400 })
}
