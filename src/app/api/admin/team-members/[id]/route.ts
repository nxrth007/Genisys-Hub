import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * PATCH /api/admin/team-members/[id]
 *
 * Admin-side approval / denial / password-reset for Team #1 users.
 * Body actions:
 *   - approve: required callCenterNumber — assigns it + flips
 *              role to team_member. Clears registrationLookupCode
 *              once approval is complete (it has done its job).
 *   - deny:    flips role to team_denied.
 *   - reset_password: bcrypt-hashes a new password supplied by
 *                     admin. Out-of-band reset — Team #1 has no
 *                     email-based recovery; admin tells the user
 *                     the new password through Mary/WhatsApp.
 *   - set_call_center_number: admin can re-assign or change a
 *                             number on an already-approved user
 *                             (e.g. if the phone provider rotated
 *                             the extension).
 *
 * DELETE /api/admin/team-members/[id] — permanent removal. No sheet
 * cleanup like the agent path since team users don't own sheet
 * tabs.
 */

type Body = {
  action?:
    | 'approve'
    | 'deny'
    | 'reset_password'
    | 'set_call_center_number'
  callCenterNumber?: string
  newPassword?: string
}

/** Canonicalize a call-center number entered by admin. Strips any
 *  whitespace + non-digit characters so "ext. 4082" and "4082" both
 *  resolve to the same canonical "4082". Returns null when the
 *  result is empty (caller treats that as "value not provided"). */
function canonicalizeCallCenterNumber(raw: string): string | null {
  const digits = String(raw).replace(/\D/g, '')
  return digits.length > 0 ? digits : null
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role
  // Approval is admin-only — assigning a call-center number affects
  // who can sign in, which is a security action.
  if (role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await ctx.params
  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const existing = await prisma.user.findFirst({
    where: { id, role: { in: ['team_pending', 'team_member', 'team_denied'] } },
    select: {
      id: true,
      name: true,
      role: true,
      callCenterNumber: true,
      registrationLookupCode: true,
    },
  })
  if (!existing) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const data: Record<string, unknown> = {}

  // approve + set_call_center_number share the number-assignment
  // shape. set_call_center_number leaves the role alone; approve
  // also flips role to team_member.
  if (body.action === 'approve' || body.action === 'set_call_center_number') {
    if (typeof body.callCenterNumber !== 'string') {
      return NextResponse.json(
        { error: 'callCenterNumber is required for this action' },
        { status: 400 },
      )
    }
    const canon = canonicalizeCallCenterNumber(body.callCenterNumber)
    if (!canon) {
      return NextResponse.json(
        { error: 'callCenterNumber must contain at least one digit' },
        { status: 400 },
      )
    }
    // Uniqueness pre-check so we can return a friendly error rather
    // than relying on the partial-unique-index P2002. (The index
    // is still there as the source of truth — this is just UX.)
    const collision = await prisma.user.findFirst({
      where: { callCenterNumber: canon, NOT: { id } },
      select: { id: true, name: true },
    })
    if (collision) {
      return NextResponse.json(
        {
          error: `That call-center number is already assigned to ${collision.name ?? 'another user'}. Pick a different one.`,
        },
        { status: 409 },
      )
    }
    data.callCenterNumber = canon

    if (body.action === 'approve') {
      data.role = 'team_member'
      // Lookup code has done its job — clear so the row doesn't
      // keep showing the disambiguator. Keeping it null also makes
      // future "is this user pending" checks cleanly tied to role.
      data.registrationLookupCode = null
    }
  } else if (body.action === 'deny') {
    data.role = 'team_denied'
  } else if (body.action === 'reset_password') {
    if (
      typeof body.newPassword !== 'string' ||
      body.newPassword.length < 8
    ) {
      return NextResponse.json(
        { error: 'New password must be at least 8 characters.' },
        { status: 400 },
      )
    }
    data.passwordHash = await bcrypt.hash(body.newPassword, 10)
  } else {
    return NextResponse.json(
      { error: 'Unknown or missing action' },
      { status: 400 },
    )
  }

  const updated = await prisma.user.update({
    where: { id },
    data,
    select: {
      id: true,
      name: true,
      role: true,
      callCenterNumber: true,
      registrationLookupCode: true,
      updatedAt: true,
    },
  })

  return NextResponse.json({ ok: true, member: updated })
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await ctx.params
  const existing = await prisma.user.findFirst({
    where: { id, role: { in: ['team_pending', 'team_member', 'team_denied'] } },
    select: { id: true },
  })
  if (!existing) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  await prisma.user.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
