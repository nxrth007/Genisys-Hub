import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { readImportState, defaultAccountId } from '@/lib/hl/ghl-import'
import { hlGuard } from '@/lib/hl/http'
import { registrarStatus } from '@/lib/hl/porkbun'
import { twilioOverview } from '@/lib/hl/twilio'

/**
 * GET: the agency view's numbers (GHL's Agency Dashboard) across every
 * sub-account, and the setup checklist for the agency Launchpad.
 */
export async function GET() {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const now = new Date()
  const d30 = new Date(now.getTime() - 30 * 86_400_000)
  const d7 = new Date(now.getTime() - 7 * 86_400_000)
  const [accounts, clientsWithout, leads30, leads7, texts7, upcoming, open, won30, twilio, porkbun, homeId] = await Promise.all([
    prisma.hlAccount.findMany({
      where: { archivedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, ghlLocationId: true, createdAt: true, numbers: { where: { status: 'active' }, select: { kind: true, verificationStatus: true } }, _count: { select: { contacts: true, workflows: true, calendars: true, domains: true } } },
    }),
    prisma.client.count({ where: { archivedAt: null, hlAccount: null } }),
    prisma.hlContact.groupBy({ by: ['accountId'], where: { createdAt: { gte: d30 } }, _count: { _all: true } }),
    prisma.hlContact.groupBy({ by: ['accountId'], where: { createdAt: { gte: d7 } }, _count: { _all: true } }),
    prisma.hlMessage.groupBy({ by: ['accountId'], where: { createdAt: { gte: d7 }, channel: 'sms' }, _count: { _all: true } }),
    prisma.hlAppointment.groupBy({ by: ['accountId'], where: { startTime: { gte: now }, status: { notIn: ['cancelled', 'invalid'] } }, _count: { _all: true } }),
    prisma.hlOpportunity.groupBy({ by: ['accountId'], where: { status: 'open' }, _count: { _all: true }, _sum: { value: true } }),
    prisma.hlOpportunity.groupBy({ by: ['accountId'], where: { status: 'won', closedAt: { gte: d30 } }, _count: { _all: true }, _sum: { value: true } }),
    twilioOverview(),
    registrarStatus(),
    defaultAccountId(),
  ])
  const pick = <T extends { accountId: string }>(rows: T[], id: string) => rows.find((r) => r.accountId === id)
  const rows = accounts.map((a) => ({
    id: a.id,
    name: a.name,
    home: a.id === homeId,
    fromGhl: !!a.ghlLocationId,
    contacts: a._count.contacts,
    leads30: pick(leads30, a.id)?._count._all ?? 0,
    leads7: pick(leads7, a.id)?._count._all ?? 0,
    texts7: pick(texts7, a.id)?._count._all ?? 0,
    upcoming: pick(upcoming, a.id)?._count._all ?? 0,
    openDeals: pick(open, a.id)?._count._all ?? 0,
    openValue: pick(open, a.id)?._sum.value ?? 0,
    won30: pick(won30, a.id)?._count._all ?? 0,
    wonValue30: pick(won30, a.id)?._sum.value ?? 0,
    texting: a.numbers.some((n) => n.kind === 'toll_free' && n.verificationStatus === 'approved') ? 'live' : a.numbers.length ? 'pending' : 'none',
    workflows: a._count.workflows,
    calendars: a._count.calendars,
    domains: a._count.domains,
  }))
  const imported = homeId ? await readImportState(homeId) : null
  const approved = twilio.profiles.some((p) => p.status === 'twilio-approved')
  return NextResponse.json({
    accounts: rows,
    totals: {
      accounts: rows.length,
      contacts: rows.reduce((s, r) => s + r.contacts, 0),
      leads30: rows.reduce((s, r) => s + r.leads30, 0),
      leads7: rows.reduce((s, r) => s + r.leads7, 0),
      upcoming: rows.reduce((s, r) => s + r.upcoming, 0),
      openValue: rows.reduce((s, r) => s + r.openValue, 0),
      wonValue30: rows.reduce((s, r) => s + r.wonValue30, 0),
    },
    setup: [
      { key: 'twilio', label: 'Connect Twilio', done: twilio.ok, detail: twilio.ok ? `Connected${twilio.accountName ? `: ${twilio.accountName}` : ''}` : (twilio.error ?? 'Add the Twilio keys to the Vault'), href: null },
      { key: 'trusthub', label: 'Twilio business profile approved', done: approved, detail: approved ? 'Toll-free verification can be filed for clients' : 'Needed before texting can be verified', href: null },
      { key: 'porkbun', label: 'Connect Porkbun (domains)', done: porkbun.connected, detail: porkbun.connected ? `Connected: ${porkbun.account ?? 'account'}${porkbun.sandbox ? ' (sandbox)' : ''}` : 'Add the Porkbun keys to the Vault', href: null },
      { key: 'import', label: 'Import Lead Genisys from GoHighLevel', done: imported?.status === 'done', detail: imported ? `Import ${imported.status}` : 'Not run yet', href: homeId ? `/hell-level/${homeId}/settings?tab=import` : '/hell-level' },
      { key: 'accounts', label: 'Give every client a sub-account', done: clientsWithout === 0, detail: clientsWithout ? `${clientsWithout} client(s) without one` : 'Every client has one', href: '/hell-level' },
      { key: 'numbers', label: 'Get a client texting', done: rows.some((r) => r.texting === 'live'), detail: `${rows.filter((r) => r.texting === 'live').length} sub-account(s) texting`, href: null },
    ],
  })
}
