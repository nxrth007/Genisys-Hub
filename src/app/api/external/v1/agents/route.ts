import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { withOwnerApi, externalOptions } from '@/lib/external-api'

/**
 * GET /api/external/v1/agents — everyone who can reach Genisys.
 *
 * Includes CRM registrations awaiting approval, since approving them is
 * done from this screen and a pending person who is invisible here is a
 * person nobody approves.
 */

const VISIBLE_ROLES = [
  'admin',
  'member',
  'agent',
  'agent_pending',
  'agent_denied',
  'crm_user',
  'crm_pending',
  'crm_denied',
]

export const GET = withOwnerApi(async (_req, auth) => {
  const [users, byAgent, sessions] = await Promise.all([
    prisma.user.findMany({
      where: { role: { in: VISIBLE_ROLES } },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        image: true,
        createdAt: true,
        approvedAt: true,
        timezone: true,
        phoneNumber: true,
        servicingState: true,
        passwordHash: true,
      },
    }),
    prisma.appointment.groupBy({
      by: ['agentUserId'],
      _count: { _all: true },
      _max: { apptDateTime: true },
    }),
    prisma.apiToken.groupBy({
      by: ['createdById'],
      where: { scope: 'session', revokedAt: null },
      _count: { _all: true },
      _max: { lastUsedAt: true },
    }),
  ])

  const stats = new Map(
    byAgent.map((r) => [
      r.agentUserId,
      { count: r._count._all, last: r._max.apptDateTime },
    ]),
  )
  const live = new Map(
    sessions.map((r) => [
      r.createdById ?? '',
      { count: r._count._all, lastUsedAt: r._max.lastUsedAt },
    ]),
  )

  return users.map(({ passwordHash, ...u }) => ({
    ...u,
    // Never send the hash — only whether sign-in is even possible.
    hasPassword: !!passwordHash,
    appointmentCount: stats.get(u.id)?.count ?? 0,
    lastBookingAt: stats.get(u.id)?.last ?? null,
    activeSessions: live.get(u.id)?.count ?? 0,
    lastSeenAt: live.get(u.id)?.lastUsedAt ?? null,
    isSelf: u.id === auth.user?.id,
  }))
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
