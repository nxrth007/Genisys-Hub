import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { getManageableTeamNumber } from '@/lib/team-manager'

/**
 * PATCH /api/team/manage/members/[id]
 *
 * Manager-scoped Team #N actions. Body action:
 *   - approve:         requires callCenterNumber; flips role to
 *                       team_member + sets the number + clears
 *                       registrationLookupCode.
 *   - deny:            flips role to team_denied.
 *
 * Deliberately MISSING (admin-only via /api/admin/team-members/[id]):
 *   - reset_password   — destructive, admin owns
 *   - set_call_center_number on active users — destructive, admin owns
 *   - delete            — irreversible, admin owns
 *
 * Even when role=admin/member calls this endpoint, the permission
 * subset stays narrow — they should use /api/admin/team-members for
 * full powers.
 */

type Body = {
  action?: 'approve' | 'deny'
  callCenterNumber?: string
}

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
  const role = (session.user as { role?: string } | undefined)?.role ?? null

  const { id } = await ctx.params
  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // Fetch target FIRST so we know which team it belongs to —
  // permission check needs that to call getManageableTeamNumber
  // with the right requireTeam.
  const target = await prisma.user.findFirst({
    where: { id, role: { in: ['team_pending', 'team_member', 'team_denied'] } },
    select: {
      id: true,
      name: true,
      teamNumber: true,
      role: true,
      callCenterNumber: true,
    },
  })
  if (!target) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  // Permission check: caller must manage the team this target
  // belongs to (or be admin/member).
  const manageableTeam = await getManageableTeamNumber({
    userId: session.user.id,
    role,
    requireTeam: target.teamNumber ?? undefined,
  })
  if (manageableTeam === null) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const data: Record<string, unknown> = {}

  if (body.action === 'approve') {
    if (typeof body.callCenterNumber !== 'string') {
      return NextResponse.json(
        { error: 'callCenterNumber is required for approval' },
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
    // Uniqueness pre-check — the partial unique index would catch
    // collisions at the DB level, but a 409 with the friendly name
    // helps the manager pick a different one without guessing.
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
    data.role = 'team_member'
    data.callCenterNumber = canon
    data.registrationLookupCode = null
  } else if (body.action === 'deny') {
    data.role = 'team_denied'
  } else {
    return NextResponse.json(
      { error: 'Unknown or missing action (approve / deny only)' },
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
