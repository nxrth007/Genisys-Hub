import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import { prisma } from '@/lib/prisma'
import { DAY, NOT_BLOCKED, accountLink, clip, contactLink, missedWithoutFollowUp, personName, waitingOnReply, when } from './ask-data'
import { launchpad } from './launchpad'
import { textingReady } from './messages'

/**
 * Ask AI's "Needs attention" list: what to look at before asking anything,
 * for one sub-account or (agency view) across all of them. Plain database
 * checks, so it's free and instant; each section carries the question that
 * gets Ask AI to go through it.
 */

export type AttentionItem = { label: string; detail: string; at: string | null; link: string }
export type AttentionSection = { key: string; title: string; hint: string; count: number; items: AttentionItem[]; ask: string }
export type Attention = { sections: AttentionSection[]; today: { label: string; value: number; link: string | null }[] }

const SHOW = 6
const CONTACT = { select: { id: true, firstName: true, lastName: true, phone: true, email: true } } as const

const ago = (d: Date) => {
  const m = Math.max(0, Math.round((Date.now() - d.getTime()) / 60_000))
  if (m < 60) return `${m} min`
  if (m < 48 * 60) return `${Math.round(m / 60)} h`
  return `${Math.round(m / 1440)} days`
}

/** Midnight to midnight today, where the sub-account is. */
function today(tz: string) {
  const start = fromZonedTime(`${formatInTimeZone(new Date(), tz, 'yyyy-MM-dd')}T00:00:00`, tz)
  return { gte: start, lt: new Date(start.getTime() + DAY) }
}

/** One sub-account's list. */
export async function accountAttention(accountId: string): Promise<Attention> {
  const account = await prisma.hlAccount.findUniqueOrThrow({ where: { id: accountId }, select: { timezone: true } })
  const tz = account.timezone || 'America/New_York'
  const now = Date.now()
  const d7 = new Date(now - 7 * DAY)
  const d14 = new Date(now - 14 * DAY)
  const d60 = new Date(now - 60 * DAY)
  // Deals whose person was talking in the last two months but has heard nothing for two weeks.
  const quietWhere = { accountId, status: 'open', contact: { lastMessageAt: { gte: d60, lt: d14 } } }
  const [waiting, missed, failedMsgs, failedRuns, quiet, quietCount, lp, leads24, appts, unread, overdue] = await Promise.all([
    waitingOnReply(accountId, d14),
    missedWithoutFollowUp(accountId, d7),
    prisma.hlMessage.findMany({ where: { accountId, direction: 'outbound', status: { in: ['failed', 'undelivered'] }, createdAt: { gte: d7 } }, orderBy: { createdAt: 'desc' }, take: 50, include: { contact: CONTACT } }),
    prisma.hlWorkflowRun.findMany({ where: { accountId, status: 'failed', updatedAt: { gte: d7 } }, orderBy: { updatedAt: 'desc' }, take: 50, include: { workflow: { select: { name: true } }, contact: CONTACT } }),
    prisma.hlOpportunity.findMany({ where: quietWhere, orderBy: { value: 'desc' }, take: SHOW, include: { contact: { select: { ...CONTACT.select, lastMessageAt: true } } } }),
    prisma.hlOpportunity.count({ where: quietWhere }),
    launchpad(accountId),
    prisma.hlContact.count({ where: { accountId, createdAt: { gte: new Date(now - DAY) } } }),
    prisma.hlAppointment.count({ where: { accountId, ...NOT_BLOCKED, startTime: today(tz), status: { notIn: ['cancelled', 'invalid'] } } }),
    prisma.hlContact.count({ where: { accountId, unread: { gt: 0 } } }),
    prisma.hlTask.count({ where: { accountId, completed: false, dueDate: { lt: today(tz).lt } } }),
  ])
  const base = `/hell-level/${accountId}`
  const gaps = lp.items.filter((i) => !i.done)
  return {
    today: [
      { label: 'New leads (24 h)', value: leads24, link: `${base}/contacts` },
      { label: 'Appointments today', value: appts, link: `${base}/calendars?tab=appointments` },
      { label: 'Unread conversations', value: unread, link: `${base}/conversations?filter=unread` },
      { label: 'Tasks due', value: overdue, link: `${base}/contacts?tab=tasks` },
    ],
    sections: [
      {
        key: 'waiting',
        title: 'Waiting on a reply',
        hint: 'Their last text or email came in and nobody has answered (last 14 days).',
        count: waiting.length,
        items: waiting.slice(0, SHOW).map((w) => ({ label: personName(w.contact), detail: `${w.channel === 'email' ? 'Emailed' : 'Texted'} ${ago(w.createdAt)} ago: “${clip(w.body, 70)}”`, at: when(w.createdAt, tz), link: contactLink(accountId, w.contactId) })),
        ask: 'Who is waiting on a reply, and how long has each been waiting?',
      },
      {
        key: 'missed',
        title: 'Missed calls, no text back',
        hint: 'Calls nobody picked up, and nothing went back after (last 7 days).',
        count: missed.length,
        items: missed.slice(0, SHOW).map((m) => ({ label: personName(m.contact), detail: `Called ${ago(m.createdAt)} ago`, at: when(m.createdAt, tz), link: contactLink(accountId, m.contactId) })),
        ask: 'Which missed calls never got a text back, and has anyone followed up since?',
      },
      {
        key: 'failed',
        title: 'Texts and emails that didn’t go through',
        hint: 'Last 7 days.',
        count: failedMsgs.length,
        items: failedMsgs.slice(0, SHOW).map((m) => ({ label: personName(m.contact), detail: clip(m.error || `The ${m.channel === 'email' ? 'email' : 'text'} failed`, 90), at: when(m.createdAt, tz), link: contactLink(accountId, m.contactId) })),
        ask: 'Which texts or emails failed this week, and why?',
      },
      {
        key: 'runs',
        title: 'Automations that stopped on an error',
        hint: 'Last 7 days.',
        count: failedRuns.length,
        items: failedRuns.slice(0, SHOW).map((r) => ({ label: `${r.workflow.name}: ${personName(r.contact)}`, detail: clip(lastFailure(r.log) ?? 'Stopped on an error', 90), at: when(r.updatedAt, tz), link: contactLink(accountId, r.contactId) })),
        ask: 'Which automations stopped on an error this week, and what went wrong?',
      },
      {
        key: 'deals',
        title: 'Open deals gone quiet',
        hint: 'Talking in the last 2 months, nothing either way for 2+ weeks. Biggest first.',
        count: quietCount,
        items: quiet.map((o) => ({ label: `${personName(o.contact)}${o.value ? ` · $${o.value.toLocaleString('en-US')}` : ''}`, detail: `${o.name}. Last message ${o.contact.lastMessageAt ? `${ago(o.contact.lastMessageAt)} ago` : 'never'}`, at: when(o.contact.lastMessageAt, tz), link: contactLink(accountId, o.contactId) })),
        ask: 'Which open deals have gone quiet, biggest first, and what was the last thing said to each?',
      },
      {
        key: 'setup',
        title: 'Setup to finish',
        hint: 'From the Launchpad.',
        count: gaps.length,
        items: gaps.slice(0, SHOW).map((i) => ({ label: i.title, detail: clip(i.detail, 110), at: null, link: `${base}/${i.href}` })),
        ask: 'What is left to set up on this sub-account, and what is each step waiting on?',
      },
    ],
  }
}

/** Every sub-account at once, for the agency view. */
export async function agencyAttention(): Promise<Attention> {
  const tz = 'America/New_York'
  const now = Date.now()
  const d7 = new Date(now - 7 * DAY)
  const d14 = new Date(now - 14 * DAY)
  const [accounts, waiting, missed, failedMsgs, failedRuns, lastLead, leads24, appts] = await Promise.all([
    prisma.hlAccount.findMany({
      where: { archivedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, clientId: true, createdAt: true, numbers: { where: { status: 'active' }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }], take: 1, select: { kind: true, verificationStatus: true } } },
    }),
    waitingOnReply(null, d14),
    missedWithoutFollowUp(null, d7),
    prisma.hlMessage.groupBy({ by: ['accountId'], where: { direction: 'outbound', status: { in: ['failed', 'undelivered'] }, createdAt: { gte: d7 } }, _count: { _all: true } }),
    prisma.hlWorkflowRun.groupBy({ by: ['accountId'], where: { status: 'failed', updatedAt: { gte: d7 } }, _count: { _all: true } }),
    prisma.hlContact.groupBy({ by: ['accountId'], _max: { createdAt: true } }),
    prisma.hlContact.count({ where: { createdAt: { gte: new Date(now - DAY) }, account: { archivedAt: null } } }),
    prisma.hlAppointment.count({ where: { ...NOT_BLOCKED, startTime: today(tz), status: { notIn: ['cancelled', 'invalid'] }, account: { archivedAt: null } } }),
  ])
  const live = new Set(accounts.map((a) => a.id))
  const count = (rows: { accountId: string }[]) => {
    const m = new Map<string, number>()
    for (const r of rows) if (live.has(r.accountId)) m.set(r.accountId, (m.get(r.accountId) ?? 0) + 1)
    return m
  }
  const waitingBy = count(waiting)
  const missedBy = count(missed)
  const failedBy = new Map<string, { msgs: number; runs: number }>()
  for (const r of failedMsgs) if (live.has(r.accountId)) failedBy.set(r.accountId, { msgs: r._count._all, runs: 0 })
  for (const r of failedRuns) if (live.has(r.accountId)) failedBy.set(r.accountId, { msgs: failedBy.get(r.accountId)?.msgs ?? 0, runs: r._count._all })
  const name = (id: string) => accounts.find((a) => a.id === id)?.name ?? 'Sub-account'
  const byCount = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])
  const total = (m: Map<string, number>) => [...m.values()].reduce((x, y) => x + y, 0)

  const clients = accounts.filter((a) => a.clientId)
  const quiet = clients
    .filter((a) => a.createdAt < d14)
    .map((a) => ({ a, last: lastLead.find((l) => l.accountId === a.id)?._max.createdAt ?? null }))
    .filter((x) => !x.last || x.last < d14)
    .sort((x, y) => (x.last?.getTime() ?? 0) - (y.last?.getTime() ?? 0))
  const notTexting = clients
    .map((a) => ({ a, n: a.numbers[0] ?? null }))
    .filter((x) => !x.n || !textingReady(x.n).ok)
  const failing = [...failedBy.entries()].sort((a, b) => b[1].msgs + b[1].runs - (a[1].msgs + a[1].runs))
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

  return {
    today: [
      { label: 'New leads (24 h)', value: leads24, link: null },
      { label: 'Appointments today', value: appts, link: null },
      { label: 'Sub-accounts', value: accounts.length, link: '/hell-level' },
    ],
    sections: [
      {
        key: 'quiet',
        title: 'Clients with no new leads in 14 days',
        hint: 'The ones most likely to cancel. Oldest last lead first.',
        count: quiet.length,
        items: quiet.slice(0, SHOW).map(({ a, last }) => ({ label: a.name, detail: last ? `Last lead ${ago(last)} ago` : 'No leads yet', at: when(last, tz), link: accountLink(a.id) })),
        ask: 'Which clients have gone quiet, when did each last get a lead, and is anything broken on their end?',
      },
      {
        key: 'waiting',
        title: 'Leads waiting on a reply',
        hint: 'Their last text or email came in and nobody answered (last 14 days).',
        count: total(waitingBy),
        items: byCount(waitingBy).slice(0, SHOW).map(([id, n]) => ({ label: name(id), detail: plural(n, 'person'), at: null, link: accountLink(id, 'conversations') })),
        ask: 'Across all clients, who is waiting on a reply, and which clients are slowest to answer?',
      },
      {
        key: 'missed',
        title: 'Missed calls, no text back',
        hint: 'Last 7 days.',
        count: total(missedBy),
        items: byCount(missedBy).slice(0, SHOW).map(([id, n]) => ({ label: name(id), detail: plural(n, 'missed call'), at: null, link: accountLink(id, 'conversations') })),
        ask: 'Which clients had missed calls that never got a text back this week?',
      },
      {
        key: 'failed',
        title: 'Failed texts and automations',
        hint: 'Last 7 days.',
        count: failing.reduce((n, [, f]) => n + f.msgs + f.runs, 0),
        items: failing.slice(0, SHOW).map(([id, f]) => ({ label: name(id), detail: [f.msgs && plural(f.msgs, 'message'), f.runs && plural(f.runs, 'automation')].filter(Boolean).join(', '), at: null, link: accountLink(id, 'conversations') })),
        ask: 'Which clients had texts or automations fail this week, and why?',
      },
      {
        key: 'texting',
        title: 'Texting not live',
        hint: 'Client sub-accounts whose number can’t text yet.',
        count: notTexting.length,
        items: notTexting.slice(0, SHOW).map(({ a, n }) => ({ label: a.name, detail: !n ? 'No number yet' : n.kind === 'toll_free' ? 'Toll-free verification pending' : 'A2P registration pending', at: null, link: accountLink(a.id, 'settings?tab=phone-numbers') })),
        ask: 'Whose texting still isn’t live, and what is each one waiting on?',
      },
    ],
  }
}

function lastFailure(log: unknown): string | null {
  if (!Array.isArray(log)) return null
  const e = [...(log as { ok?: boolean; detail?: string }[])].reverse().find((x) => x.ok === false)
  return e?.detail ?? null
}
