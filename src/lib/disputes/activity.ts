/**
 * A dashboard sign-in. The password is never written down. Genisys OS
 * logins resolve to the client's sub-account; the client portal uses
 * the user's own client id.
 */
import { isIP } from 'node:net'
import { prisma } from '@/lib/prisma'
import { requestContext } from '@/lib/request-context'
import { writeLedger } from './ledger'

function oneLine(v: string | null | undefined, max: number): string | null {
  const t = (v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, max) : null
}

export async function recordDashboardLogin(o: { userId: string; email: string | null; role?: string | null; ip?: string | null; userAgent?: string | null }): Promise<void> {
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
  const ctx = requestContext.getStore()
  const rawIp = (o.ip ?? ctx?.ip ?? '').trim()
  const ip = rawIp && rawIp !== 'unknown' && isIP(rawIp) ? rawIp : null
  const userAgent = oneLine(o.userAgent ?? ctx?.userAgent, 300)
  const activity = await prisma.portalActivity.create({
    data: { userId: o.userId, clientId, email: o.email, kind: 'login', ip, userAgent },
  })
  if (!clientId) return
  const where = [ip && ip !== 'unknown' ? `ip ${ip}` : null, userAgent ? `ua ${userAgent.slice(0, 160)}` : null].filter(Boolean).join('; ')
  await writeLedger([
    {
      clientId,
      kind: 'login',
      title: `Dashboard login${o.email ? ` (${o.email})` : ''}`,
      detail: `The password is not stored. This is the sign-in itself.${where ? ` ${where}.` : ''}`,
      occurredAt: activity.createdAt,
      source: 'portal',
      sourceId: activity.id,
    },
  ])
}
