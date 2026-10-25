import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { createAccountForClient, createStandaloneAccount, readProfile, repairClientProfile } from '@/lib/hl/accounts'
import { applyClientKit } from '@/lib/hl/client-kit'
import { defaultAccountId } from '@/lib/hl/ghl-import'
import { hlError, hlGuard, hlViewer, jsonBody, str } from '@/lib/hl/http'

/**
 * GET  /api/hl/accounts: every sub-account (the switcher and the agency view),
 *      plus the clients that don't have one yet. A sub-account's own login
 *      gets just theirs (their first is "home").
 * POST /api/hl/accounts { clientId } | { all: true } | { name }: create.
 * POST /api/hl/accounts { clientKit: 'all' | accountId }: bring client
 *      sub-accounts up to the client kit (GHL's client workflows), repairing
 *      profiles crossed onboarding answers got wrong.
 */
export async function GET() {
  const viewer = await hlViewer()
  if (viewer instanceof NextResponse) return viewer
  const only = viewer.accountIds
  const mine = only ? { accountId: { in: only } } : {}
  const [accounts, clients] = await Promise.all([
    prisma.hlAccount.findMany({
      where: { archivedAt: null, ...(only ? { id: { in: only } } : {}) },
      orderBy: { name: 'asc' },
      include: {
        numbers: { where: { status: 'active' }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }], take: 1 },
        _count: { select: { contacts: true } },
        client: { select: { id: true, name: true, contactName: true, lifecycle: true } },
      },
    }),
    only
      ? []
      : prisma.client.findMany({
          where: { archivedAt: null, hlAccount: null },
          orderBy: { name: 'asc' },
          select: { id: true, name: true, contactName: true, lifecycle: true },
        }),
  ])
  const unread = await prisma.hlContact.groupBy({ by: ['accountId'], where: { unread: { gt: 0 }, ...mine }, _count: { _all: true } })
  const homeId = only ? (only[0] ?? null) : await defaultAccountId()
  const lastLead = await prisma.hlContact.groupBy({ by: ['accountId'], where: mine, _max: { createdAt: true } })
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
        ghlLocationId: a.ghlLocationId,
        number: a.numbers[0] ? { number: a.numbers[0].number, kind: a.numbers[0].kind, verification: a.numbers[0].verificationStatus } : null,
        contacts: a._count.contacts,
        unread: unread.find((u) => u.accountId === a.id)?._count._all ?? 0,
        lastLeadAt: lastLead.find((l) => l.accountId === a.id)?._max.createdAt ?? null,
        createdAt: a.createdAt,
      }
    }),
    clientsWithout: clients,
    defaultAccountId: homeId,
  })
}

export async function POST(req: Request) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  try {
    const body = await jsonBody(req)
    const kitFor = str(body.clientKit)
    if (kitFor) {
      const accounts = await prisma.hlAccount.findMany({
        where: { archivedAt: null, clientId: { not: null }, ...(kitFor === 'all' ? {} : { id: kitFor }) },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      })
      const results = []
      for (const a of accounts) {
        const repaired = await repairClientProfile(a.id)
        const kit = await applyClientKit(a.id)
        results.push({ id: a.id, name: a.name, repaired, ...kit })
      }
      return NextResponse.json({ results })
    }
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
