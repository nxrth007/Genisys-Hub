/**
 * A dashboard sign-in. The password is never written down. Genisys OS
 * logins resolve to the client's sub-account; the client portal uses
 * the user's own client id.
 */
import { prisma } from '@/lib/prisma'
import { writeLedger } from './ledger'

export async function recordDashboardLogin(o: { userId: string; email: string | null; role?: string | null }): Promise<void> {
  const role = o.role ?? ''
  let clientId: string | null = null
  if (role === 'hl_user' || !role) {
    const member = await prisma.hlMember.findFirst({
      where: { userId: o.userId, account: { archivedAt: null, clientId: { not: null } } },
      select: { account: { select: { clientId: true } } },
    })
    clientId = member?.account.clientId ?? null
  }
  if (!clientId && role.startsWith('client_')) {
    const user = await prisma.user.findUnique({ where: { id: o.userId }, select: { clientId: true } })
    clientId = user?.clientId ?? null
  }
  const activity = await prisma.portalActivity.create({
    data: { userId: o.userId, clientId, email: o.email, kind: 'login' },
  })
  if (!clientId) return
  await writeLedger([
    {
      clientId,
      kind: 'login',
      title: `Dashboard login${o.email ? ` (${o.email})` : ''}`,
      detail: 'The password is not stored. This is the sign-in itself.',
      occurredAt: activity.createdAt,
      source: 'portal',
      sourceId: activity.id,
    },
  ])
}
