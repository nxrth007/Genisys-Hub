import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { readProfile } from './accounts'
import { launchpad } from './launchpad'
import { prettyPhone } from './merge'
import { textingReady } from './messages'
import type { HlStage } from './types'

/**
 * What Ask AI reads (src/lib/hl/ask.ts): plain, read-only lookups over one
 * sub-account, or every sub-account for the agency view. Results come back
 * small and JSON-ready, times in the sub-account's own timezone, and each
 * person with their Hell-level link so an answer can point at them.
 */

export const DAY = 86_400_000
const MAX_ROWS = 50

export const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

type NameParts = { firstName?: string | null; lastName?: string | null; phone?: string | null; email?: string | null }
export const personName = (c: NameParts | null | undefined) =>
  !c ? 'Unknown' : [c.firstName, c.lastName].filter(Boolean).join(' ') || (c.phone ? prettyPhone(c.phone) : '') || c.email || 'Unknown'

export const contactLink = (accountId: string, contactId: string) => `/hell-level/${accountId}/conversations?contact=${contactId}`
export const accountLink = (accountId: string, page = 'dashboard') => `/hell-level/${accountId}/${page}`

/** "Tue Oct 21 2026, 2:05 PM" in the sub-account's timezone. */
export const when = (d: Date | null | undefined, tz: string) => (d ? formatInTimeZone(d, tz, 'EEE MMM d yyyy, h:mm a') : null)

/** A date or date-time from the model: "2026-10-01" is midnight that day in the sub-account's timezone. */
export function parseWhen(v: unknown, tz: string): Date | null {
  if (typeof v !== 'string' || !v.trim()) return null
  const s = v.trim()
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? fromZonedTime(`${s}T00:00:00`, tz) : /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? new Date(s) : fromZonedTime(s, tz)
  return Number.isNaN(d.getTime()) ? null : d
}

export const limitOf = (v: unknown, fallback = 25) => Math.max(1, Math.min(MAX_ROWS, Math.floor(Number(v) || fallback)))
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

export type Scope = { accountId: string; tz: string }

/** The sub-account's name and timezone, or null when there's no such (live) sub-account. */
export async function scopeOf(accountId: string): Promise<(Scope & { name: string; business: string }) | null> {
  const a = await prisma.hlAccount.findFirst({ where: { id: accountId, archivedAt: null }, select: { id: true, name: true, timezone: true, profile: true } })
  if (!a) return null
  return { accountId: a.id, tz: a.timezone || 'America/New_York', name: a.name, business: readProfile(a.profile).businessName || a.name }
}

const CONTACT_SELECT = { id: true, firstName: true, lastName: true, phone: true, email: true } as const

/** Real appointments, not blocked-off time (`source <> 'block'` alone would also drop ones with no source). */
export const NOT_BLOCKED = { OR: [{ source: null }, { source: { not: 'block' } }] } satisfies Prisma.HlAppointmentWhereInput

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

/** find_contacts: by name, phone or email, tag, source and when they came in. */
export async function findContacts(s: Scope, f: Record<string, unknown>) {
  const q = text(f.query)
  const digits = q?.replace(/\D/g, '') ?? ''
  const after = parseWhen(f.created_after, s.tz)
  const before = parseWhen(f.created_before, s.tz)
  const where: Prisma.HlContactWhereInput = {
    accountId: s.accountId,
    ...(q
      ? {
          OR: [
            // Every word of a name, in the first or last name ("john smith" isn't every John and every Smith).
            { AND: q.split(/\s+/).map((w) => ({ OR: [{ firstName: { contains: w, mode: 'insensitive' as const } }, { lastName: { contains: w, mode: 'insensitive' as const } }] })) },
            { email: { contains: q, mode: 'insensitive' } },
            ...(digits.length >= 4 ? [{ phone: { contains: digits.slice(-10) } }] : []),
          ],
        }
      : {}),
    ...(text(f.tag) ? { tags: { has: text(f.tag)! } } : {}),
    ...(text(f.source) ? { source: text(f.source)! } : {}),
    ...(after || before ? { createdAt: { ...(after ? { gte: after } : {}), ...(before ? { lt: before } : {}) } } : {}),
    ...(f.unread === true ? { unread: { gt: 0 } } : {}),
    ...(f.starred === true ? { starred: true } : {}),
  }
  const take = limitOf(f.limit)
  const [rows, total] = await Promise.all([
    prisma.hlContact.findMany({
      where,
      orderBy: f.sort === 'last_message' ? [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }] : [{ createdAt: 'desc' }],
      take,
      select: { ...CONTACT_SELECT, source: true, tags: true, createdAt: true, lastMessageAt: true, lastMessage: true, unread: true, dnd: true, emailDnd: true, smsConsent: true, starred: true },
    }),
    prisma.hlContact.count({ where }),
  ])
  return {
    total,
    showing: rows.length,
    contacts: rows.map((c) => ({
      id: c.id,
      name: personName(c),
      phone: c.phone ? prettyPhone(c.phone) : null,
      email: c.email,
      source: c.source,
      tags: c.tags,
      came_in: when(c.createdAt, s.tz),
      last_message: c.lastMessageAt ? { at: when(c.lastMessageAt, s.tz), text: clip(c.lastMessage, 120) } : null,
      unread: c.unread,
      texts_allowed: c.smsConsent && !c.dnd,
      ...(c.dnd ? { texted_stop: true } : {}),
      ...(c.emailDnd ? { no_email: true } : {}),
      link: contactLink(s.accountId, c.id),
    })),
  }
}

/** contact_details: one person with their conversation, deals, appointments, tasks, automations and form answers. */
export async function contactDetails(s: Scope, f: Record<string, unknown>) {
  const id = text(f.contact_id)
  const c = id ? await prisma.hlContact.findFirst({ where: { id, accountId: s.accountId } }) : null
  if (!c) return { error: 'No contact with that id in this sub-account. Use find_contacts to get the id.' }
  const [messages, opps, appointments, tasks, runs, forms, pipelines] = await Promise.all([
    prisma.hlMessage.findMany({ where: { contactId: c.id }, orderBy: { createdAt: 'desc' }, take: 40 }),
    prisma.hlOpportunity.findMany({ where: { contactId: c.id }, orderBy: { createdAt: 'desc' }, take: 10 }),
    prisma.hlAppointment.findMany({ where: { contactId: c.id }, orderBy: { startTime: 'desc' }, take: 10, include: { calendar: { select: { name: true } } } }),
    prisma.hlTask.findMany({ where: { contactId: c.id }, orderBy: { createdAt: 'desc' }, take: 10 }),
    prisma.hlWorkflowRun.findMany({ where: { contactId: c.id }, orderBy: { createdAt: 'desc' }, take: 10, include: { workflow: { select: { name: true } } } }),
    prisma.hlFormSubmission.findMany({ where: { contactId: c.id }, orderBy: { createdAt: 'desc' }, take: 5, include: { form: { select: { name: true } } } }),
    prisma.hlPipeline.findMany({ where: { accountId: s.accountId }, select: { id: true, name: true, stages: true } }),
  ])
  const stage = stageNames(pipelines)
  return {
    id: c.id,
    name: personName(c),
    phone: c.phone ? prettyPhone(c.phone) : null,
    email: c.email,
    source: c.source,
    tags: c.tags,
    came_in: when(c.createdAt, s.tz),
    texts_allowed: c.smsConsent && !c.dnd,
    texted_stop: c.dnd,
    no_email: c.emailDnd ? c.emailDndReason || true : false,
    unread: c.unread,
    link: contactLink(s.accountId, c.id),
    conversation_newest_first: messages.map((m) => ({
      at: when(m.createdAt, s.tz),
      channel: m.channel,
      direction: m.direction,
      status: m.status,
      text: clip(m.body, 300),
      ...(m.error ? { error: clip(m.error, 200) } : {}),
      ...(m.by ? { by: m.by } : {}),
    })),
    deals: opps.map((o) => ({ name: o.name, pipeline: stage.pipeline(o.pipelineId), stage: stage.of(o.pipelineId, o.stageId), status: o.status, value: o.value, opened: when(o.createdAt, s.tz), updated: when(o.updatedAt, s.tz) })),
    appointments: appointments.map((a) => ({ title: a.title, starts: when(a.startTime, s.tz), status: a.status, calendar: a.calendar?.name ?? null })),
    tasks: tasks.map((t) => ({ title: t.title, due: when(t.dueDate, s.tz), done: t.completed })),
    automations: runs.map((r) => ({ workflow: r.workflow.name, status: r.status, started: when(r.createdAt, s.tz), last_step: lastLog(r.log) })),
    form_answers: forms.map((x) => ({ form: x.form.name, at: when(x.createdAt, s.tz), answers: answers(x.data) })),
  }
}

// ---------------------------------------------------------------------------
// Messages, calls, notes
// ---------------------------------------------------------------------------

/** search_messages: texts, emails, calls and notes by channel, direction, status, words and time. */
export async function searchMessages(s: Scope, f: Record<string, unknown>) {
  const after = parseWhen(f.after, s.tz)
  const before = parseWhen(f.before, s.tz)
  const where: Prisma.HlMessageWhereInput = {
    accountId: s.accountId,
    ...(text(f.channel) ? { channel: text(f.channel)! } : { channel: { not: 'activity' } }),
    ...(text(f.direction) ? { direction: text(f.direction)! } : {}),
    ...(text(f.status) ? { status: text(f.status)! } : {}),
    ...(text(f.contains) ? { body: { contains: text(f.contains)!, mode: 'insensitive' } } : {}),
    ...(text(f.contact_id) ? { contactId: text(f.contact_id)! } : {}),
    ...(after || before ? { createdAt: { ...(after ? { gte: after } : {}), ...(before ? { lt: before } : {}) } } : {}),
  }
  const take = limitOf(f.limit)
  const [rows, total] = await Promise.all([
    prisma.hlMessage.findMany({ where, orderBy: { createdAt: 'desc' }, take, include: { contact: { select: CONTACT_SELECT } } }),
    prisma.hlMessage.count({ where }),
  ])
  return {
    total,
    showing: rows.length,
    messages: rows.map((m) => ({
      at: when(m.createdAt, s.tz),
      contact: personName(m.contact),
      channel: m.channel,
      direction: m.direction,
      status: m.status,
      text: clip(m.body, 220),
      ...(m.error ? { error: clip(m.error, 200) } : {}),
      ...(m.by ? { by: m.by } : {}),
      link: contactLink(s.accountId, m.contactId),
    })),
  }
}

/** People whose last text or email came in and hasn't been answered since (newest window first). */
export async function waitingOnReply(accountId: string | null, since: Date) {
  const rows = await prisma.$queryRaw<{ contactId: string; accountId: string; direction: string; channel: string; body: string; createdAt: Date; automatic: boolean | null }[]>`
    SELECT DISTINCT ON (m."contactId") m."contactId", m."accountId", m."direction", m."channel", m."body", m."createdAt",
      (m."meta"->>'automatic') = 'true' AS automatic
    FROM "HlMessage" m
    WHERE m."channel" IN ('sms', 'email') AND m."createdAt" >= ${since}
      AND (${accountId}::text IS NULL OR m."accountId" = ${accountId})
    ORDER BY m."contactId", m."createdAt" DESC`
  const waiting = rows.filter((r) => r.direction === 'inbound' && !r.automatic)
  if (!waiting.length) return []
  const contacts = await prisma.hlContact.findMany({ where: { id: { in: waiting.map((w) => w.contactId) }, dnd: false }, select: CONTACT_SELECT })
  const byId = new Map(contacts.map((c) => [c.id, c]))
  return waiting
    .filter((w) => byId.has(w.contactId))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((w) => ({ ...w, contact: byId.get(w.contactId)! }))
}

/** Missed calls that never got a text, call or email back afterwards (one per person, the latest). */
export async function missedWithoutFollowUp(accountId: string | null, since: Date) {
  const missed = await prisma.hlMessage.findMany({
    where: { ...(accountId ? { accountId } : {}), channel: 'call', status: 'missed', createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: 500,
    select: { contactId: true, accountId: true, createdAt: true, contact: { select: CONTACT_SELECT } },
  })
  if (!missed.length) return []
  const replies = await prisma.hlMessage.findMany({
    where: { contactId: { in: [...new Set(missed.map((m) => m.contactId))] }, direction: 'outbound', channel: { in: ['sms', 'call', 'email'] }, createdAt: { gte: since } },
    select: { contactId: true, createdAt: true },
  })
  const seen = new Set<string>()
  return missed.filter((m) => {
    if (seen.has(m.contactId)) return false
    seen.add(m.contactId)
    return !replies.some((r) => r.contactId === m.contactId && r.createdAt > m.createdAt)
  })
}

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------

function stageNames(pipelines: { id: string; name: string; stages: unknown }[]) {
  return {
    pipeline: (pipelineId: string) => pipelines.find((p) => p.id === pipelineId)?.name ?? null,
    of: (pipelineId: string, stageId: string) => ((pipelines.find((p) => p.id === pipelineId)?.stages as HlStage[] | undefined) ?? []).find((x) => x.id === stageId)?.name ?? null,
  }
}

/** list_opportunities: deals by pipeline, stage, status, value and how long they've been quiet. */
export async function listOpportunities(s: Scope, f: Record<string, unknown>) {
  const pipelines = await prisma.hlPipeline.findMany({ where: { accountId: s.accountId }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true, stages: true } })
  const names = stageNames(pipelines)
  const want = text(f.pipeline)?.toLowerCase()
  const pipeline = want ? pipelines.find((p) => p.name.toLowerCase() === want) ?? pipelines.find((p) => p.name.toLowerCase().includes(want)) : null
  if (want && !pipeline) return { error: `No pipeline like "${f.pipeline}". Pipelines here: ${pipelines.map((p) => p.name).join(', ') || 'none'}.` }
  const stageWant = text(f.stage)?.toLowerCase()
  const stageIds = stageWant
    ? (pipeline ? [pipeline] : pipelines).flatMap((p) => ((p.stages as HlStage[]) ?? []).filter((x) => x.name.toLowerCase().includes(stageWant)).map((x) => x.id))
    : null
  if (stageIds && !stageIds.length) return { error: `No stage like "${f.stage}".` }
  const quiet = Number(f.quiet_days) > 0 ? new Date(Date.now() - Number(f.quiet_days) * DAY) : null
  const after = parseWhen(f.created_after, s.tz)
  const before = parseWhen(f.created_before, s.tz)
  const where: Prisma.HlOpportunityWhereInput = {
    accountId: s.accountId,
    ...(pipeline ? { pipelineId: pipeline.id } : {}),
    ...(stageIds ? { stageId: { in: stageIds } } : {}),
    ...(text(f.status) ? { status: text(f.status)! } : {}),
    ...(Number(f.min_value) > 0 || Number(f.max_value) > 0
      ? { value: { ...(Number(f.min_value) > 0 ? { gte: Number(f.min_value) } : {}), ...(Number(f.max_value) > 0 ? { lte: Number(f.max_value) } : {}) } }
      : {}),
    ...(after || before ? { createdAt: { ...(after ? { gte: after } : {}), ...(before ? { lt: before } : {}) } } : {}),
    // Quiet = no messages either way since then (imported deals' updatedAt is the import, so it says nothing).
    ...(quiet ? { contact: { OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: quiet } }] } } : {}),
  }
  const take = limitOf(f.limit)
  const orderBy: Prisma.HlOpportunityOrderByWithRelationInput = f.sort === 'value' ? { value: 'desc' } : f.sort === 'oldest' ? { updatedAt: 'asc' } : { createdAt: 'desc' }
  const [rows, total, sum] = await Promise.all([
    prisma.hlOpportunity.findMany({ where, orderBy, take, include: { contact: { select: { ...CONTACT_SELECT, lastMessageAt: true } } } }),
    prisma.hlOpportunity.count({ where }),
    prisma.hlOpportunity.aggregate({ where, _sum: { value: true } }),
  ])
  return {
    total,
    total_value: sum._sum.value ?? 0,
    showing: rows.length,
    pipelines: pipelines.map((p) => ({ name: p.name, stages: ((p.stages as HlStage[]) ?? []).map((x) => x.name) })),
    deals: rows.map((o) => ({
      name: o.name,
      contact: personName(o.contact),
      pipeline: names.pipeline(o.pipelineId),
      stage: names.of(o.pipelineId, o.stageId),
      status: o.status,
      value: o.value,
      source: o.source,
      opened: when(o.createdAt, s.tz),
      updated: when(o.updatedAt, s.tz),
      last_message: when(o.contact.lastMessageAt, s.tz),
      ...(o.closedAt ? { closed: when(o.closedAt, s.tz) } : {}),
      link: contactLink(s.accountId, o.contactId),
    })),
  }
}

// ---------------------------------------------------------------------------
// Appointments and tasks
// ---------------------------------------------------------------------------

/** list_appointments: booked, cancelled, showed or no-show appointments in a time range. */
export async function listAppointments(s: Scope, f: Record<string, unknown>) {
  const after = parseWhen(f.after, s.tz) ?? new Date()
  const before = parseWhen(f.before, s.tz)
  const where: Prisma.HlAppointmentWhereInput = {
    accountId: s.accountId,
    ...NOT_BLOCKED,
    startTime: { gte: after, ...(before ? { lt: before } : {}) },
    ...(text(f.status) ? { status: text(f.status)! } : { status: { notIn: ['invalid'] } }),
    ...(text(f.calendar) ? { calendar: { name: { contains: text(f.calendar)!, mode: 'insensitive' } } } : {}),
  }
  const take = limitOf(f.limit)
  const [rows, total] = await Promise.all([
    prisma.hlAppointment.findMany({ where, orderBy: { startTime: 'asc' }, take, include: { calendar: { select: { name: true } }, contact: { select: CONTACT_SELECT } } }),
    prisma.hlAppointment.count({ where }),
  ])
  return {
    total,
    showing: rows.length,
    appointments: rows.map((a) => ({
      title: a.title,
      contact: a.contact ? personName(a.contact) : null,
      starts: when(a.startTime, s.tz),
      ends: when(a.endTime, s.tz),
      status: a.status,
      calendar: a.calendar?.name ?? null,
      with: a.assignedTo,
      ...(a.address ? { address: a.address } : {}),
      ...(a.contactId ? { link: contactLink(s.accountId, a.contactId) } : {}),
    })),
  }
}

/** list_tasks: open or done tasks, by due date. */
export async function listTasks(s: Scope, f: Record<string, unknown>) {
  const before = parseWhen(f.due_before, s.tz)
  const where: Prisma.HlTaskWhereInput = {
    accountId: s.accountId,
    ...(f.status === 'done' ? { completed: true } : f.status === 'all' ? {} : { completed: false }),
    ...(before ? { dueDate: { lt: before } } : {}),
  }
  const take = limitOf(f.limit)
  const [rows, total] = await Promise.all([
    prisma.hlTask.findMany({ where, orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }], take, include: { contact: { select: CONTACT_SELECT } } }),
    prisma.hlTask.count({ where }),
  ])
  return {
    total,
    showing: rows.length,
    tasks: rows.map((t) => ({
      title: t.title,
      ...(t.body ? { note: clip(t.body, 160) } : {}),
      due: when(t.dueDate, s.tz),
      done: t.completed,
      for: t.assignedTo,
      contact: t.contact ? personName(t.contact) : null,
      ...(t.contactId ? { link: contactLink(s.accountId, t.contactId) } : {}),
    })),
  }
}

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

type LogEntry = { at?: string; step?: number; type?: string; ok?: boolean; detail?: string }
const logOf = (log: unknown): LogEntry[] => (Array.isArray(log) ? (log as LogEntry[]) : [])

/** The step a run stopped or last did something on, in a few words. */
function lastLog(log: unknown): string | null {
  const entries = logOf(log)
  const failed = [...entries].reverse().find((e) => e.ok === false)
  const last = failed ?? entries[entries.length - 1]
  return last ? clip(`${last.type ?? 'step'}: ${last.detail ?? (last.ok ? 'ok' : 'failed')}`, 220) : null
}

/** workflow_runs: who went through which automation, and where runs failed or are waiting. */
export async function workflowRuns(s: Scope, f: Record<string, unknown>) {
  const after = parseWhen(f.after, s.tz)
  const where: Prisma.HlWorkflowRunWhereInput = {
    accountId: s.accountId,
    ...(text(f.status) ? { status: text(f.status)! } : {}),
    ...(text(f.workflow) ? { workflow: { name: { contains: text(f.workflow)!, mode: 'insensitive' } } } : {}),
    ...(after ? { updatedAt: { gte: after } } : {}),
  }
  const take = limitOf(f.limit)
  const [rows, total, published] = await Promise.all([
    prisma.hlWorkflowRun.findMany({ where, orderBy: { updatedAt: 'desc' }, take, include: { workflow: { select: { name: true } }, contact: { select: CONTACT_SELECT } } }),
    prisma.hlWorkflowRun.count({ where }),
    prisma.hlWorkflow.findMany({ where: { accountId: s.accountId, status: 'published', deletedAt: null }, select: { name: true }, orderBy: { name: 'asc' } }),
  ])
  return {
    total,
    showing: rows.length,
    workflows_switched_on: published.map((w) => w.name),
    runs: rows.map((r) => ({
      workflow: r.workflow.name,
      contact: personName(r.contact),
      status: r.status,
      started: when(r.createdAt, s.tz),
      updated: when(r.updatedAt, s.tz),
      ...(r.nextRunAt ? { next_step_at: when(r.nextRunAt, s.tz) } : {}),
      last_step: lastLog(r.log),
      link: contactLink(s.accountId, r.contactId),
    })),
  }
}

// ---------------------------------------------------------------------------
// Numbers over a period
// ---------------------------------------------------------------------------

/** activity_stats: leads, forms, texts, calls, email, bookings and deals over a period, and how fast new leads heard back. */
export async function activityStats(s: Scope, f: Record<string, unknown>) {
  const after = parseWhen(f.after, s.tz) ?? new Date(Date.now() - 30 * DAY)
  const before = parseWhen(f.before, s.tz) ?? new Date()
  const range = { gte: after, lt: before }
  const acct = s.accountId
  const msg = (where: Prisma.HlMessageWhereInput) => prisma.hlMessage.count({ where: { accountId: acct, createdAt: range, ...where } })
  const [leads, sources, forms, formNames, textsOut, textsIn, textsFailed, emailsOut, emailsIn, callsAnswered, callsMissed, booked, won, lost, newDeals] = await Promise.all([
    prisma.hlContact.findMany({ where: { accountId: acct, createdAt: range }, select: { id: true, createdAt: true }, take: 2000 }),
    prisma.hlContact.groupBy({ by: ['source'], where: { accountId: acct, createdAt: range }, _count: { _all: true } }),
    prisma.hlFormSubmission.groupBy({ by: ['formId'], where: { accountId: acct, createdAt: range }, _count: { _all: true } }),
    prisma.hlForm.findMany({ where: { accountId: acct }, select: { id: true, name: true } }),
    msg({ channel: 'sms', direction: 'outbound', status: { notIn: ['failed', 'undelivered'] } }),
    msg({ channel: 'sms', direction: 'inbound' }),
    msg({ channel: 'sms', direction: 'outbound', status: { in: ['failed', 'undelivered'] } }),
    msg({ channel: 'email', direction: 'outbound', status: { notIn: ['failed'] } }),
    msg({ channel: 'email', direction: 'inbound' }),
    msg({ channel: 'call', status: 'answered' }),
    msg({ channel: 'call', status: 'missed' }),
    prisma.hlAppointment.count({ where: { accountId: acct, createdAt: range, ...NOT_BLOCKED } }),
    prisma.hlOpportunity.aggregate({ where: { accountId: acct, status: 'won', closedAt: range }, _count: { _all: true }, _sum: { value: true } }),
    prisma.hlOpportunity.aggregate({ where: { accountId: acct, status: 'lost', closedAt: range }, _count: { _all: true }, _sum: { value: true } }),
    prisma.hlOpportunity.count({ where: { accountId: acct, createdAt: range } }),
  ])
  // Speed to lead: from coming in to the first text, call or email out.
  const firstOut = leads.length
    ? await prisma.hlMessage.groupBy({
        by: ['contactId'],
        where: { contactId: { in: leads.map((l) => l.id) }, direction: 'outbound', channel: { in: ['sms', 'call', 'email'] }, status: { notIn: ['failed', 'undelivered'] }, createdAt: { gte: after } },
        _min: { createdAt: true },
      })
    : []
  const waits = leads
    .map((l) => {
      const out = firstOut.find((x) => x.contactId === l.id)?._min.createdAt
      return out && out >= l.createdAt ? (out.getTime() - l.createdAt.getTime()) / 60_000 : null
    })
    .filter((m): m is number => m !== null)
    .sort((a, b) => a - b)
  const formName = (id: string) => formNames.find((x) => x.id === id)?.name ?? 'a deleted form'
  return {
    from: when(after, s.tz),
    to: when(before, s.tz),
    new_leads: leads.length,
    leads_by_source: Object.fromEntries(sources.map((x) => [x.source ?? 'unknown', x._count._all])),
    form_submissions: Object.fromEntries(forms.map((x) => [formName(x.formId), x._count._all])),
    texts: { sent: textsOut, received: textsIn, failed: textsFailed },
    emails: { sent: emailsOut, received: emailsIn },
    calls: { answered: callsAnswered, missed: callsMissed },
    appointments_booked: booked,
    deals: { opened: newDeals, won: won._count._all, won_value: won._sum.value ?? 0, lost: lost._count._all, lost_value: lost._sum.value ?? 0 },
    speed_to_lead: {
      leads_contacted: waits.length,
      leads_never_contacted: leads.length - waits.length,
      median_minutes: waits.length ? Math.round(waits[Math.floor(waits.length / 2)] * 10) / 10 : null,
      within_5_minutes: waits.filter((m) => m <= 5).length,
    },
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/** account_setup: the Launchpad checklist, the number and whether it can text, and email. */
export async function accountSetup(s: Scope) {
  const [lp, numbers, email, account] = await Promise.all([
    launchpad(s.accountId),
    prisma.hlPhoneNumber.findMany({ where: { accountId: s.accountId, status: 'active' }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] }),
    prisma.hlEmailDomain.findUnique({ where: { accountId: s.accountId }, select: { domain: true, status: true, lastError: true } }),
    prisma.hlAccount.findUniqueOrThrow({ where: { id: s.accountId }, select: { profile: true, timezone: true, createdAt: true } }),
  ])
  const p = readProfile(account.profile)
  return {
    business: { name: p.businessName ?? null, owner: p.ownerName ?? null, website: p.website ?? null, timezone: account.timezone, in_hell_level_since: when(account.createdAt, s.tz) },
    launchpad: lp.items.map((i) => ({ step: i.title, done: i.done, detail: i.detail })),
    numbers: numbers.map((n) => ({ number: prettyPhone(n.number), kind: n.kind, can_text: textingReady(n).ok, ...(textingReady(n).reason ? { why_not: textingReady(n).reason } : {}), calls_forward_to: n.forwardTo ? prettyPhone(n.forwardTo) : null })),
    email: email ? { domain: email.domain, status: email.status, ...(email.lastError ? { problem: email.lastError } : {}) } : 'not set up',
  }
}

// ---------------------------------------------------------------------------
// Agency view: every sub-account
// ---------------------------------------------------------------------------

/** list_sub_accounts: each client's sub-account with this week's and month's numbers. */
export async function subAccounts(f: Record<string, unknown>) {
  const now = Date.now()
  const d7 = new Date(now - 7 * DAY)
  const d30 = new Date(now - 30 * DAY)
  const q = text(f.name)?.toLowerCase()
  const [accounts, leads7, leads30, lastLead, failed7, runsFailed7, open] = await Promise.all([
    prisma.hlAccount.findMany({
      where: { archivedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, clientId: true, createdAt: true, profile: true, numbers: { where: { status: 'active' }, select: { kind: true, verificationStatus: true } } },
    }),
    prisma.hlContact.groupBy({ by: ['accountId'], where: { createdAt: { gte: d7 } }, _count: { _all: true } }),
    prisma.hlContact.groupBy({ by: ['accountId'], where: { createdAt: { gte: d30 } }, _count: { _all: true } }),
    prisma.hlContact.groupBy({ by: ['accountId'], _max: { createdAt: true } }),
    prisma.hlMessage.groupBy({ by: ['accountId'], where: { createdAt: { gte: d7 }, direction: 'outbound', status: { in: ['failed', 'undelivered'] } }, _count: { _all: true } }),
    prisma.hlWorkflowRun.groupBy({ by: ['accountId'], where: { updatedAt: { gte: d7 }, status: 'failed' }, _count: { _all: true } }),
    prisma.hlOpportunity.groupBy({ by: ['accountId'], where: { status: 'open' }, _count: { _all: true }, _sum: { value: true } }),
  ])
  const pick = <T extends { accountId: string }>(rows: T[], id: string) => rows.find((r) => r.accountId === id)
  const tz = 'America/New_York'
  const rows = accounts
    .filter((a) => !q || a.name.toLowerCase().includes(q) || (readProfile(a.profile).businessName ?? '').toLowerCase().includes(q))
    .map((a) => {
      const number = a.numbers[0] ?? null
      return {
        id: a.id,
        name: a.name,
        client: !!a.clientId,
        leads_7_days: pick(leads7, a.id)?._count._all ?? 0,
        leads_30_days: pick(leads30, a.id)?._count._all ?? 0,
        last_lead: when(pick(lastLead, a.id)?._max.createdAt ?? null, tz),
        texting: !number ? 'no number' : textingReady(number).ok ? 'live' : number.kind === 'toll_free' ? 'toll-free verification pending' : 'A2P registration pending',
        failed_messages_7_days: pick(failed7, a.id)?._count._all ?? 0,
        failed_automations_7_days: pick(runsFailed7, a.id)?._count._all ?? 0,
        open_deals: pick(open, a.id)?._count._all ?? 0,
        open_value: pick(open, a.id)?._sum.value ?? 0,
        in_hell_level_since: when(a.createdAt, tz),
        link: accountLink(a.id),
      }
    })
  return { total: rows.length, sub_accounts: rows }
}

/** A sub-account named by the model in the agency view: its id, or its name (close enough). */
export async function resolveAccount(v: unknown): Promise<(Scope & { name: string }) | { error: string }> {
  const want = text(v)
  if (!want) return { error: 'Say which sub-account (its name or id). list_sub_accounts lists them.' }
  const byId = await scopeOf(want)
  if (byId) return byId
  const all = await prisma.hlAccount.findMany({ where: { archivedAt: null }, select: { id: true, name: true, profile: true } })
  const w = want.toLowerCase()
  const names = (a: (typeof all)[number]) => [a.name, readProfile(a.profile).businessName ?? ''].map((n) => n.toLowerCase())
  const exact = all.filter((a) => names(a).includes(w))
  const close = exact.length ? exact : all.filter((a) => names(a).some((n) => n && (n.includes(w) || w.includes(n))))
  if (close.length === 1) return (await scopeOf(close[0].id))!
  if (!close.length) return { error: `No sub-account called "${want}". list_sub_accounts lists them.` }
  return { error: `"${want}" matches several sub-accounts: ${close.map((a) => a.name).join(', ')}. Say which.` }
}

function answers(data: unknown): Record<string, string> {
  if (!data || typeof data !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(data as Record<string, unknown>).slice(0, 20)) {
    if (v === null || v === undefined || v === '') continue
    out[k] = clip(typeof v === 'string' ? v : JSON.stringify(v), 160)
  }
  return out
}
