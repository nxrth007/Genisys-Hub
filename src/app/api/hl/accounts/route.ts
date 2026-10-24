import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { createAccountForClient, createStandaloneAccount, readProfile } from '@/lib/hl/accounts'
import { hlError, hlGuard, jsonBody, str } from '@/lib/hl/http'

/**
 * GET  /api/hl/accounts: every sub-account (the switcher and the agency view),
 *      plus the clients that don't have one yet.
 * POST /api/hl/accounts { clientId } | { all: true } | { name }: create.
 */
export async function GET() {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const [accounts, clients] = await Promise.all([
    prisma.hlAccount.findMany({
      where: { archivedAt: null },
      orderBy: { name: 'asc' },
      include: {
        numbers: { where: { status: 'active' }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }], take: 1 },
        _count: { select: { contacts: true } },
        client: { select: { id: true, name: true, contactName: true, lifecycle: true } },
      },
    }),
    prisma.client.findMany({
      where: { archivedAt: null, hlAccount: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, contactName: true, lifecycle: true },
    }),
  ])
  const unread = await prisma.hlContact.groupBy({ by: ['accountId'], where: { unread: { gt: 0 } }, _count: { _all: true } })
  const lastLead = await prisma.hlContact.groupBy({ by: ['accountId'], _max: { createdAt: true } })
  return NextResponse.json({
    accounts: accounts.map((a) => {
      const p = readProfile(a.profile)
      return {
        id: a.id,
        name: a.name,
        clientId: a.clientId,
        clientName: a.client?.name ?? null,
        owner: p.ownerName || a.client?.contactName || null,
        website: p.website || null,
        number: a.numbers[0] ? { number: a.numbers[0].number, kind: a.numbers[0].kind, verification: a.numbers[0].verificationStatus } : null,
        contacts: a._count.contacts,
        unread: unread.find((u) => u.accountId === a.id)?._count._all ?? 0,
        lastLeadAt: lastLead.find((l) => l.accountId === a.id)?._max.createdAt ?? null,
        createdAt: a.createdAt,
      }
    }),
    clientsWithout: clients,
  })
}

export async function POST(req: Request) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  try {
    const body = await jsonBody(req)
    if (body.all === true) {
      const clients = await prisma.client.findMany({ where: { archivedAt: null, hlAccount: null }, select: { id: true } })
      let created = 0
      for (const c of clients) if ((await createAccountForClient(c.id)).created) created++
      return NextResponse.json({ created })
    }
    const clientId = str(body.clientId)
    if (clientId) return NextResponse.json(await createAccountForClient(clientId))
    return NextResponse.json(await createStandaloneAccount(str(body.name) ?? ''))
  } catch (err) {
    return hlError(err, 'create sub-account')
  }
}
