import { toZonedTime, fromZonedTime } from 'date-fns-tz'
import { prisma } from '@/lib/prisma'
import type { HlContact, HlWorkflow, Prisma } from '@/generated/prisma/client'
import { readProfile } from './accounts'
import { addTags, removeTags } from './contacts'
import { renderTemplate, type MergeAppointment, type MergeData } from './merge'
import { sendEmailToContact } from './email'
import { sendInternalEmail, sendInternalSms, sendSmsToContact } from './messages'
import { replyIntent } from './intent'
import { trackedLink } from './links'
import { emailList, phoneList, toE164 } from './phone'
import { publicBase } from './twilio'
import type { HlBranch, HlCondition, HlStage, HlStep, HlTrigger, HlTriggerType } from './types'

/**
 * The workflow engine. A trigger (form sent, missed call, reply…) starts a
 * run for each published workflow that listens for it; a run walks the
 * workflow's steps until a Wait, which parks it with nextRunAt. The scheduler
 * resumes parked runs every minute (resumeDueRuns).
 *
 * Workflows built in Hell-level run their steps in list order. Ones brought
 * over from GoHighLevel link each step to the next (`next`), with if/else
 * branches, go-tos and splits, the way GHL runs them; a GHL action Hell-level
 * can't run yet stops the run there with a note in its log.
 *
 * Runs are claimed with a conditional update before they move, so the
 * overlapping containers of a rolling deploy can't both send the same text.
 */

export type TriggerEvent = {
  type: HlTriggerType
  formId?: string
  text?: string
  tag?: string
  stageId?: string
  pipelineId?: string
  calendarId?: string
  /** appointment_status: confirmed | cancelled | showed | noshow | rescheduled */
  status?: string
  /** link_clicked: which tracked link. */
  link?: string
  /** Saved on the run for merge fields: { form: {...} } / { call: {...} } / { appointmentId }. */
  context?: Record<string, unknown>
}

type LogLine = { at: string; step: number; type: string; ok: boolean; detail: string }

/** Tag and stage triggers can set off further triggers; this stops a loop. */
const MAX_DEPTH = 3
/** A second identical trigger this soon (a webhook retried) doesn't start a second run. */
const DUPLICATE_MS = 60_000
/** A run whose worker died mid-way is picked up again after this. */
const LOCK_MS = 5 * 60_000
/** Delayed texts wait for daytime in the sub-account's timezone. */
const QUIET_START = 21
const QUIET_END = 8
/** Steps one move can take before it's called a loop (a go-to with no wait). */
const MAX_HOPS = 200

const asTrigger = (v: unknown) => (v ?? {}) as HlTrigger
export const asSteps = (v: unknown) => (Array.isArray(v) ? (v as HlStep[]) : [])
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** Every trigger of a workflow: several when it came from GHL, else the one. */
export function asTriggers(w: Pick<HlWorkflow, 'trigger' | 'triggers'>): HlTrigger[] {
  const list = Array.isArray(w.triggers) ? (w.triggers as HlTrigger[]) : []
  return list.length ? list : [asTrigger(w.trigger)]
}

/** A reply as GHL compares it: lower case, no surrounding quotes or end punctuation. */
const squash = (s: string) => s.trim().toLowerCase().replace(/^["'\u201c\u201d\u2018\u2019]+|["'\u201c\u201d\u2018\u2019.!?]+$/g, '').trim()

/**
 * Does the reply match one of the trigger's phrases? "exact" = the whole reply
 * is the phrase; "contains" = the phrase appears as whole words, so "no"
 * catches "No thanks" but not "I know".
 */
export function replyMatches(text: string, phrases: string[], match: 'contains' | 'exact' | undefined): boolean {
  const reply = squash(text)
  return phrases.some((p) => {
    const want = squash(p)
    if (!want) return false
    if (match === 'exact') return reply === want
    return new RegExp(`(^|[^a-z0-9])${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(reply)
  })
}

function triggerMatches(t: HlTrigger, e: TriggerEvent): boolean {
  // Switched off in GHL, or a GHL trigger with no Hell-level equivalent: never fires.
  if (t.active === false || t.type === 'ghl' || t.type !== e.type) return false
  if (t.type === 'form_submitted' || t.type === 'chat_submitted') {
    if (t.formId && t.formId !== e.formId) return false
    if (t.formIds?.length && !t.formIds.includes(e.formId ?? '')) return false
  }
  if (t.type === 'inbound_sms') {
    const phrases = t.keywords?.length ? t.keywords : t.keyword?.trim() ? [t.keyword] : []
    if (phrases.length && !replyMatches(e.text ?? '', phrases, t.match)) return false
  }
  if (t.type === 'link_clicked' && t.link && t.link !== e.link) return false
  if (t.type === 'tag_added' && t.tag?.trim() && t.tag.trim().toLowerCase() !== (e.tag ?? '').toLowerCase()) return false
  if (t.type === 'opportunity_stage' || t.type === 'opportunity_created') {
    if (t.stageId && t.stageId !== e.stageId) return false
    if (t.pipelineId && e.pipelineId && t.pipelineId !== e.pipelineId) return false
  }
  if ((t.type === 'appointment_booked' || t.type === 'appointment_status') && t.calendarId && t.calendarId !== e.calendarId) return false
  if (t.type === 'appointment_status' && t.status && t.status !== e.status) return false
  return true
}

/** The trigger of this workflow that the event sets off, if any. */
export function matchingTrigger(w: Pick<HlWorkflow, 'trigger' | 'triggers'>, e: TriggerEvent): HlTrigger | null {
  return asTriggers(w).find((t) => triggerMatches(t, e)) ?? null
}

/** Start every published workflow of the sub-account that listens for this event. Returns how many started. */
export async function fireTrigger(accountId: string, contactId: string, e: TriggerEvent, depth = 0): Promise<number> {
  if (depth > MAX_DEPTH) return 0
  const workflows = await prisma.hlWorkflow.findMany({ where: { accountId, status: 'published', deletedAt: null }, orderBy: { createdAt: 'asc' } })
  let started = 0
  for (const w of workflows) {
    const t = matchingTrigger(w, e)
    if (!t) continue
    const earlier = await prisma.hlWorkflowRun.findFirst({
      where: { workflowId: w.id, contactId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, status: true },
    })
    if (earlier && Date.now() - earlier.createdAt.getTime() < DUPLICATE_MS) continue
    if (earlier && !w.allowReentry) continue
    const run = await prisma.hlWorkflowRun.create({
      data: {
        workflowId: w.id,
        accountId,
        contactId,
        context: { trigger: e.type, ...(t.id ? { triggerId: t.id } : {}), ...(e.text ? { text: e.text } : {}), ...(e.context ?? {}) } as Prisma.InputJsonValue,
      },
      select: { id: true },
    })
    started++
    await advanceRun(run.id, depth).catch((err) => console.error(`[hell-level] run ${run.id} failed:`, err))
  }
  return started
}

function inQuietHours(timezone: string, at = new Date()): boolean {
  const h = toZonedTime(at, timezone).getHours()
  return h >= QUIET_START || h < QUIET_END
}

/**
 * The first moment at or after `at` inside a weekly window (days 0 = Sunday,
 * HH:MM times in the zone): GHL's "wait for business hours".
 */
export function intoWindow(at: Date, w: { days: number[]; start: string; end: string }, timezone: string): Date {
  if (!w.days.length) return at
  const local = toZonedTime(at, timezone)
  const [sh, sm] = w.start.split(':').map(Number)
  const [eh, em] = w.end.split(':').map(Number)
  for (let i = 0; i < 8; i++) {
    const day = new Date(local)
    day.setDate(day.getDate() + i)
    if (!w.days.includes(day.getDay())) continue
    const open = new Date(day)
    open.setHours(sh, sm, 0, 0)
    const close = new Date(day)
    close.setHours(eh, em, 0, 0)
    if (i === 0 && local >= open && local < close) return at
    if (i > 0 || local < open) return fromZonedTime(open, timezone)
  }
  return at
}

/** 9 AM next daytime in the zone. */
function nextMorning(timezone: string, at = new Date()): Date {
  const local = toZonedTime(at, timezone)
  const target = new Date(local)
  if (local.getHours() >= QUIET_END) target.setDate(target.getDate() + 1)
  target.setHours(9, 0, 0, 0)
  return fromZonedTime(target, timezone)
}

type Ctx = {
  runId: string
  workflowId: string
  accountId: string
  timezone: string
  contact: HlContact
  merge: MergeData
  depth: number
  /** When the run started: replies after this count as replies to it. */
  startedAt: Date
  /** The run's saved context; steps may change it (a reply wait), and it's saved with the run. */
  context: Record<string, unknown>
  /** True once the run has waited at least once: its texts are no longer an instant reply. */
  delayed: boolean
  /** The appointment the run is about (appointment triggers), read fresh each time the run moves. */
  appointment: (MergeAppointment & { id: string; start: Date; cancelled: boolean }) | null
}

const WAITS = new Set(['wait', 'wait_appointment', 'wait_reply'])

/** The run's appointment, as merge fields and for "wait before the appointment". */
async function loadAppointment(id: unknown, timezone: string): Promise<Ctx['appointment']> {
  if (typeof id !== 'string' || !id) return null
  const a = await prisma.hlAppointment.findUnique({ where: { id }, include: { calendar: { select: { name: true } } } })
  if (!a) return null
  const link = a.token ? `${publicBase()}/hl/a/${a.token}` : null
  return {
    id: a.id,
    start: a.startTime,
    cancelled: a.status === 'cancelled' || a.status === 'invalid',
    title: a.title,
    startTime: a.startTime,
    endTime: a.endTime,
    timezone,
    calendarName: a.calendar?.name ?? null,
    location: a.address,
    status: a.status,
    rescheduleUrl: link,
    cancelUrl: link ? `${link}?cancel=1` : null,
  }
}

type StepResult = {
  ok: boolean
  detail: string
  waitUntil?: Date
  stop?: boolean
  retryStep?: boolean
  /** Linked workflows: go here next (if/else, go-to, split); null = the end. */
  goto?: string | null
}

const durationMs = (amount: unknown, unit: unknown) => {
  const n = Math.max(0, Number(amount) || 0)
  return n * (unit === 'days' ? 86_400_000 : unit === 'hours' ? 3_600_000 : 60_000)
}

/** What the latest reply means (GHL's AI intent), asked once per reply and kept on the run. */
async function intentOfReply(c: Ctx): Promise<'positive' | 'negative' | 'unclear' | null> {
  const reply = await prisma.hlMessage.findFirst({
    where: { contactId: c.contact.id, direction: 'inbound', channel: 'sms', createdAt: { gte: new Date(c.startedAt.getTime() - 120_000) } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, body: true },
  })
  if (!reply?.body) return null
  const known = rec(c.context.intent)
  if (known.messageId === reply.id && typeof known.intent === 'string') return known.intent as 'positive' | 'negative' | 'unclear'
  // What it's a reply to: this run's last text to them.
  const offer = await prisma.hlMessage.findFirst({
    where: { contactId: c.contact.id, direction: 'outbound', channel: 'sms', runId: c.runId },
    orderBy: { createdAt: 'desc' },
    select: { body: true },
  })
  const intent = await replyIntent(reply.body, offer?.body ?? '')
  if (intent) c.context.intent = { messageId: reply.id, intent }
  return intent
}

/** The contact's latest text since the run started (the reply it's about), or null. */
async function latestReply(c: Ctx): Promise<string | null> {
  const m = await prisma.hlMessage.findFirst({
    where: { contactId: c.contact.id, direction: 'inbound', channel: 'sms', createdAt: { gte: new Date(c.startedAt.getTime() - 120_000) } },
    orderBy: { createdAt: 'desc' },
    select: { body: true },
  })
  return m?.body ?? (typeof c.context.text === 'string' ? c.context.text : null)
}

const asList = (v: unknown) => (Array.isArray(v) ? v : [v]).map((x) => String(x ?? '').trim().toLowerCase()).filter(Boolean)

/** One GHL if/else condition. null = a kind Hell-level can't check yet (counts as not met). */
async function conditionHolds(cond: HlCondition, c: Ctx): Promise<boolean | null> {
  const op = cond.operator
  if (cond.type === 'contact_reply') {
    if (cond.subType === 'contact_replied') {
      const replied = (await latestReply(c)) !== null
      const want = String(cond.value) !== 'false'
      return replied === want
    }
    if (cond.subType === 'message.body') {
      const text = ((await latestReply(c)) ?? '').toLowerCase()
      const values = asList(cond.value)
      if (op === 'contain' || op === 'contains') return values.some((v) => text.includes(v))
      if (op === 'notContain' || op === 'not_contains') return !values.some((v) => text.includes(v))
      if (op === '==' || op === 'exact') return values.some((v) => text.trim() === v)
      if (op === '!=') return !values.some((v) => text.trim() === v)
      return null
    }
    // GHL's AI "Intent type": schedule-yes = a yes, schedule-no = a no.
    if (cond.subType === 'matches_intent') {
      const intent = await intentOfReply(c)
      if (intent === null) return null
      const want = String(cond.value).includes('no') ? 'negative' : 'positive'
      return op === '!=' ? intent !== want : intent === want
    }
    return null
  }
  if (cond.type === 'contact_detail') {
    if (cond.subType === 'tags') {
      const fresh = await prisma.hlContact.findUnique({ where: { id: c.contact.id }, select: { tags: true } })
      const has = asList(cond.value).some((t) => fresh?.tags.includes(t))
      return op === 'index-of-false' ? !has : has
    }
    const key = String(cond.subType ?? '')
    const core: Record<string, unknown> = { first_name: c.contact.firstName, last_name: c.contact.lastName, email: c.contact.email, phone: c.contact.phone, source: c.contact.source }
    const raw = key in core ? core[key] : rec(c.contact.fields)[key]
    const value = String(raw ?? '').toLowerCase()
    const want = asList(cond.value)
    if (op === '==') return want.includes(value)
    if (op === '!=') return !want.includes(value)
    if (op === 'contain' || op === 'contains') return want.some((w) => value.includes(w))
    if (op === 'notContain') return !want.some((w) => value.includes(w))
    if (op === 'is_empty' || op === 'is-empty') return !value
    if (op === 'is_not_empty' || op === 'is-not-empty') return !!value
    return null
  }
  // GHL's "Opportunity" conditions: the stage of the contact's open opportunity.
  if (cond.type === 'opportunities' && cond.subType === 'pipelineStageId') {
    const want = asList(cond.value)
    if (!want.length) return null
    const open = await prisma.hlOpportunity.findMany({ where: { contactId: c.contact.id, status: 'open' }, select: { stageId: true } })
    const inStage = open.some((o) => want.includes(o.stageId.toLowerCase()))
    return op === '!=' ? !inStage : inStage
  }
  if (cond.type === 'trigger') {
    const fired = String(c.context.triggerId ?? '')
    return op === '!=' ? fired !== String(cond.value) : fired === String(cond.value)
  }
  return null
}

/** Does this branch hold? Segments combine with the branch's AND/OR, conditions with the segment's. */
async function branchHolds(b: HlBranch, c: Ctx, unknown: string[]): Promise<boolean> {
  const segs: boolean[] = []
  for (const s of b.segments) {
    const results: boolean[] = []
    for (const cond of s.conditions) {
      const r = await conditionHolds(cond, c)
      if (r === null) unknown.push(`${cond.type}${cond.subType ? `/${cond.subType}` : ''}`)
      results.push(r === true)
    }
    segs.push(results.length ? (s.operator === 'or' ? results.some(Boolean) : results.every(Boolean)) : false)
  }
  return segs.length ? (b.operator === 'or' ? segs.some(Boolean) : segs.every(Boolean)) : false
}

const todayIn = (timezone: string) => {
  const d = toZonedTime(new Date(), timezone)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function runStep(step: HlStep, c: Ctx, index: number): Promise<StepResult> {
  const cfg = step.config ?? {}
  const render = (s: string | undefined) => renderTemplate((s ?? '').replace(/\{\{\s*today\s*\}\}/gi, todayIn(c.timezone)), c.merge)
  const profile = c.merge.account ?? {}
  const tagsOf = () => [...(cfg.tags ?? []), ...(cfg.tag ? [cfg.tag] : [])].map((t) => render(t).trim().toLowerCase()).filter(Boolean)
  switch (step.type) {
    case 'send_sms': {
      if (c.delayed && inQuietHours(c.timezone)) {
        const morning = nextMorning(c.timezone)
        // A reminder that can't go out before the appointment isn't worth sending after it.
        if (c.appointment && morning.getTime() >= c.appointment.start.getTime()) return { ok: true, detail: 'Skipped: quiet hours last until after the appointment' }
        return { ok: true, detail: 'Quiet hours: waiting until 9 AM', waitUntil: morning, retryStep: true }
      }
      const r = await sendSmsToContact({ accountId: c.accountId, contactId: c.contact.id, body: render(cfg.body), by: 'automation', runId: c.runId })
      return { ok: r.ok, detail: r.detail }
    }
    case 'send_email': {
      // From the client's own address (Settings → Email Services); until that's set up the run carries on without it.
      const r = await sendEmailToContact({ accountId: c.accountId, contactId: c.contact.id, subject: render(cfg.subject), body: render(cfg.body), fromName: cfg.fromName ? render(cfg.fromName) : undefined, by: 'automation', runId: c.runId, bulk: true })
      return { ok: r.ok, detail: r.ok ? r.detail : `${r.detail}: “${render(cfg.subject) || 'email'}” not sent, carried on` }
    }
    case 'internal_sms': {
      const to = phoneList(cfg.to?.trim() ? render(cfg.to) : profile.notifyPhone)
      const r = await sendInternalSms(c.accountId, to, render(cfg.body))
      return { ok: r.ok, detail: r.detail }
    }
    case 'internal_email': {
      const to = emailList(cfg.to?.trim() ? render(cfg.to) : profile.notifyEmail)
      const r = await sendInternalEmail(c.accountId, to, render(cfg.subject) || 'New lead', render(cfg.body))
      return { ok: r.ok, detail: r.detail }
    }
    case 'wait': {
      const ms = Math.max(1_000, durationMs(cfg.amount, cfg.unit))
      const after = new Date(Date.now() + ms)
      if (!cfg.window) return { ok: true, detail: `Waiting ${cfg.amount ?? 1} ${cfg.unit ?? 'minutes'}`, waitUntil: after }
      const until = intoWindow(after, cfg.window, c.timezone)
      return { ok: true, detail: `Waiting until ${until.toISOString()} (inside ${cfg.window.start}–${cfg.window.end})`, waitUntil: until }
    }
    case 'wait_appointment': {
      const a = c.appointment
      if (!a) return { ok: false, detail: 'No appointment on this run (the trigger wasn’t an appointment): carried on' }
      if (a.cancelled) return { ok: true, detail: 'The appointment was cancelled: stopped here', stop: true }
      const ms = durationMs(cfg.amount, cfg.unit)
      const target = new Date(a.start.getTime() + (cfg.when === 'after' ? ms : -ms))
      // Re-checked when the wait is over, so a rescheduled appointment moves it.
      if (target.getTime() <= Date.now() + 30_000) return { ok: true, detail: 'Time reached: carried on' }
      return { ok: true, detail: `Waiting until ${target.toISOString()}`, waitUntil: target, retryStep: true }
    }
    case 'wait_reply': {
      // Parked until the contact texts back (contactReplied wakes it) or the time runs out.
      const pending = rec(c.context.replyWait)
      if (pending.step === index) {
        delete c.context.replyWait
        const since = new Date(String(pending.since))
        const replied = await prisma.hlMessage.count({ where: { contactId: c.contact.id, direction: 'inbound', channel: 'sms', createdAt: { gte: since } } })
        return { ok: true, detail: replied ? 'The contact replied: carried on' : 'No reply in time: carried on' }
      }
      // No time limit (GHL's reply wait with no timeout): a year, then it carries on.
      const open = !(Number(cfg.amount) > 0)
      const ms = open ? 365 * 86_400_000 : Math.max(60_000, durationMs(cfg.amount, cfg.unit))
      c.context.replyWait = { step: index, since: new Date().toISOString() }
      return { ok: true, detail: open ? 'Waiting for a reply (no time limit)' : `Waiting for a reply (up to ${cfg.amount} ${cfg.unit ?? 'minutes'})`, waitUntil: new Date(Date.now() + ms), retryStep: true }
    }
    case 'drip':
      return { ok: true, detail: 'Drip lets contacts through in batches; one contact goes straight on here' }
    case 'add_tag': {
      const tags = tagsOf()
      if (!tags.length) return { ok: false, detail: 'No tag set' }
      const fresh = await addTags(c.contact.id, tags)
      for (const tag of fresh) await fireTrigger(c.accountId, c.contact.id, { type: 'tag_added', tag }, c.depth + 1)
      return { ok: true, detail: fresh.length ? `Tagged ${fresh.map((t) => `“${t}”`).join(', ')}` : `Already tagged ${tags.map((t) => `“${t}”`).join(', ')}` }
    }
    case 'remove_tag': {
      const tags = tagsOf()
      await removeTags(c.contact.id, tags)
      return { ok: true, detail: `Removed ${tags.map((t) => `“${t}”`).join(', ') || 'nothing'}` }
    }
    case 'create_opportunity': {
      const pipeline = cfg.pipelineId
        ? await prisma.hlPipeline.findFirst({ where: { id: cfg.pipelineId, accountId: c.accountId } })
        : await prisma.hlPipeline.findFirst({ where: { accountId: c.accountId }, orderBy: { createdAt: 'asc' } })
      if (!pipeline) return { ok: false, detail: 'The sub-account has no pipeline' }
      const stages = (pipeline.stages as HlStage[]) ?? []
      const stage = stages.find((s) => s.id === cfg.stageId) ?? stages[0]
      if (!stage) return { ok: false, detail: 'The pipeline has no stages' }
      // GHL's "Create or Update Opportunity": an open one in this pipeline moves to the stage instead.
      const open = await prisma.hlOpportunity.findFirst({ where: { contactId: c.contact.id, pipelineId: pipeline.id, status: 'open' } })
      if (open) {
        if (!cfg.stageId || open.stageId === stage.id) return { ok: true, detail: 'Already has an open opportunity in this pipeline' }
        await prisma.hlOpportunity.update({ where: { id: open.id }, data: { stageId: stage.id } })
        await fireTrigger(c.accountId, c.contact.id, { type: 'opportunity_stage', stageId: stage.id, pipelineId: pipeline.id }, c.depth + 1)
        return { ok: true, detail: `Moved the open opportunity to ${stage.name}` }
      }
      const last = await prisma.hlOpportunity.findFirst({ where: { pipelineId: pipeline.id, stageId: stage.id }, orderBy: { position: 'desc' }, select: { position: true } })
      const c0 = c.contact
      await prisma.hlOpportunity.create({
        data: {
          accountId: c.accountId,
          pipelineId: pipeline.id,
          stageId: stage.id,
          contactId: c0.id,
          name: render(cfg.oppName).trim().slice(0, 200) || [c0.firstName, c0.lastName].filter(Boolean).join(' ') || c0.phone || c0.email || 'New lead',
          source: render(cfg.source).trim().slice(0, 120) || c0.source,
          position: (last?.position ?? 0) + 1,
        },
      })
      await fireTrigger(c.accountId, c0.id, { type: 'opportunity_created', pipelineId: pipeline.id, stageId: stage.id }, c.depth + 1)
      return { ok: true, detail: `Added to ${pipeline.name} → ${stage.name}` }
    }
    case 'move_opportunity': {
      const opp = await prisma.hlOpportunity.findFirst({
        where: { contactId: c.contact.id, status: 'open', ...(cfg.pipelineId ? { pipelineId: cfg.pipelineId } : {}) },
        orderBy: { createdAt: 'desc' },
        include: { pipeline: true },
      })
      if (!opp) return { ok: false, detail: 'No open opportunity to move' }
      const stage = ((opp.pipeline.stages as HlStage[]) ?? []).find((s) => s.id === cfg.stageId)
      if (!stage) return { ok: false, detail: 'That stage no longer exists' }
      if (opp.stageId === stage.id) return { ok: true, detail: `Already in ${stage.name}` }
      await prisma.hlOpportunity.update({ where: { id: opp.id }, data: { stageId: stage.id } })
      await fireTrigger(c.accountId, c.contact.id, { type: 'opportunity_stage', stageId: stage.id, pipelineId: opp.pipelineId }, c.depth + 1)
      return { ok: true, detail: `Moved to ${stage.name}` }
    }
    case 'remove_opportunity': {
      // Only ever in the pipeline the step names, so a blank step can't clear someone's whole board.
      if (!cfg.pipelineId) return { ok: false, detail: 'No pipeline picked: nothing removed' }
      const gone = await prisma.hlOpportunity.deleteMany({ where: { accountId: c.accountId, contactId: c.contact.id, pipelineId: cfg.pipelineId } })
      return { ok: true, detail: gone.count ? `Removed ${gone.count} opportunit${gone.count === 1 ? 'y' : 'ies'}` : 'No opportunity to remove in that pipeline' }
    }
    case 'if_tag': {
      const tag = (cfg.tag ?? '').trim().toLowerCase()
      const fresh = await prisma.hlContact.findUnique({ where: { id: c.contact.id }, select: { tags: true } })
      const has = !!fresh?.tags.includes(tag)
      const wantHas = cfg.has !== false
      return has === wantHas
        ? { ok: true, detail: `Contact ${has ? 'has' : 'doesn’t have'} “${tag}”: continuing` }
        : { ok: true, detail: `Contact ${has ? 'has' : 'doesn’t have'} “${tag}”: stopped here`, stop: true }
    }
    case 'if_else': {
      const unknown: string[] = []
      for (const b of step.branches ?? []) {
        if (await branchHolds(b, c, unknown)) return { ok: true, detail: `“${b.name}”`, goto: b.next }
      }
      const note = unknown.length ? ` (couldn’t check here: ${[...new Set(unknown)].join(', ')})` : ''
      return { ok: true, detail: `“${step.elseName || 'None'}”${note}`, goto: step.elseNext ?? null }
    }
    case 'goto':
      return cfg.target ? { ok: true, detail: 'Went back to an earlier step', goto: cfg.target } : { ok: false, detail: 'Go to has no target: stopped here', stop: true }
    case 'split': {
      const paths = cfg.paths ?? []
      const total = paths.reduce((n, p) => n + Math.max(0, p.percent), 0)
      let roll = Math.random() * (total || 1)
      for (const p of paths) {
        roll -= Math.max(0, p.percent)
        if (roll <= 0) return { ok: true, detail: `Path “${p.name}”`, goto: p.next }
      }
      return { ok: true, detail: 'Split with no paths: stopped here', stop: true }
    }
    case 'dnd': {
      await prisma.hlContact.update({ where: { id: c.contact.id }, data: { dnd: cfg.dnd !== false } })
      return { ok: true, detail: cfg.dnd !== false ? 'Texting switched off (DND)' : 'Texting switched back on' }
    }
    case 'update_field': {
      const fields = { ...rec(c.contact.fields) }
      for (const f of cfg.fields ?? []) fields[f.key] = render(f.value)
      await prisma.hlContact.update({ where: { id: c.contact.id }, data: { fields: fields as Prisma.InputJsonValue } })
      return { ok: true, detail: `Updated ${(cfg.fields ?? []).map((f) => f.label || f.key).join(', ') || 'nothing'}` }
    }
    case 'update_contact': {
      const data: Prisma.HlContactUpdateInput = {}
      const fields = { ...rec(c.contact.fields) }
      for (const f of cfg.fields ?? []) {
        const v = render(f.value).trim()
        const k = f.key.replace(/[^a-z]/gi, '').toLowerCase()
        if (k === 'firstname') data.firstName = v || null
        else if (k === 'lastname') data.lastName = v || null
        else if (k === 'email') data.email = v.toLowerCase() || null
        else if (k === 'phone') data.phone = toE164(v)
        else fields[k === 'companyname' || k === 'businessname' ? 'company_name' : f.key] = v
      }
      data.fields = fields as Prisma.InputJsonValue
      await prisma.hlContact.update({ where: { id: c.contact.id }, data })
      return { ok: true, detail: 'Contact updated' }
    }
    case 'add_note': {
      await prisma.hlMessage.create({
        data: { accountId: c.accountId, contactId: c.contact.id, direction: 'outbound', channel: 'note', status: 'logged', body: render(cfg.body).slice(0, 8000), by: 'automation', runId: c.runId },
      })
      return { ok: true, detail: 'Note added' }
    }
    case 'add_to_workflow': {
      const names: string[] = []
      for (const id of cfg.workflowIds ?? []) {
        const w = await prisma.hlWorkflow.findFirst({ where: { id, accountId: c.accountId, deletedAt: null }, select: { id: true, name: true } })
        if (!w) continue
        const run = await prisma.hlWorkflowRun.create({
          data: { workflowId: w.id, accountId: c.accountId, contactId: c.contact.id, context: { trigger: 'add_to_workflow', from: c.workflowId } as Prisma.InputJsonValue },
          select: { id: true },
        })
        names.push(w.name)
        await advanceRun(run.id, c.depth + 1).catch((err) => console.error(`[hell-level] run ${run.id} failed:`, err))
      }
      return names.length ? { ok: true, detail: `Added to ${names.map((n) => `“${n}”`).join(', ')}` } : { ok: false, detail: 'That workflow isn’t here' }
    }
    case 'remove_from_workflow': {
      if (cfg.all) {
        // GHL's "Remove from all workflows": every other run of theirs ends; this one carries on to its next step.
        const ended = await prisma.hlWorkflowRun.updateMany({
          where: { contactId: c.contact.id, status: { in: ['running', 'waiting'] }, id: { not: c.runId } },
          data: { status: 'cancelled', lockedAt: null, nextRunAt: null },
        })
        return { ok: true, detail: `Removed from all workflows (${ended.count} other run${ended.count === 1 ? '' : 's'} ended)` }
      }
      const ids = cfg.workflowIds?.length ? cfg.workflowIds : [c.workflowId]
      const others = ids.filter((id) => id !== c.workflowId)
      if (others.length) {
        await prisma.hlWorkflowRun.updateMany({
          where: { contactId: c.contact.id, workflowId: { in: others }, status: { in: ['running', 'waiting'] }, id: { not: c.runId } },
          data: { status: 'cancelled', lockedAt: null, nextRunAt: null },
        })
      }
      return ids.includes(c.workflowId) ? { ok: true, detail: 'Removed from this workflow', stop: true } : { ok: true, detail: 'Removed from the other workflow' }
    }
    case 'ghl':
      return { ok: false, detail: `“${step.name || step.ghl?.type || 'GoHighLevel action'}” is a GoHighLevel action Hell-level can’t run yet (${step.ghl?.type ?? 'unknown'}): stopped here`, stop: true }
    default:
      return { ok: false, detail: `Unknown step “${(step as HlStep).type}”` }
  }
}

/** Linked workflows (from GHL) say which step comes next; Hell-level's own go down the list. */
const isLinked = (steps: HlStep[]) => steps.some((s) => s.next !== undefined || s.type === 'if_else' || s.type === 'goto' || s.type === 'split')

/** Move a run forward from its current step until it waits, stops or finishes. */
export async function advanceRun(runId: string, depth = 0): Promise<void> {
  const now = new Date()
  const claimed = await prisma.hlWorkflowRun.updateMany({
    where: {
      id: runId,
      status: { in: ['running', 'waiting'] },
      OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(now.getTime() - LOCK_MS) } }],
    },
    data: { lockedAt: now, status: 'running' },
  })
  if (!claimed.count) return
  const run = await prisma.hlWorkflowRun.findUnique({
    where: { id: runId },
    include: { workflow: true, contact: true, account: { select: { id: true, timezone: true, profile: true, archivedAt: true } } },
  })
  if (!run) return
  const log = (Array.isArray(run.log) ? run.log : []) as LogLine[]
  const context = { ...rec(run.context) }
  const finish = (status: string, step: number, extra: Partial<{ nextRunAt: Date | null }> = {}) =>
    prisma.hlWorkflowRun.update({
      where: { id: runId },
      data: { status, step, lockedAt: null, log: log as unknown as Prisma.InputJsonValue, context: context as Prisma.InputJsonValue, nextRunAt: extra.nextRunAt ?? null },
    })

  const manual = context.manual === true
  if (run.account.archivedAt || (run.workflow.status !== 'published' && !manual)) {
    log.push({ at: now.toISOString(), step: run.step, type: 'stop', ok: true, detail: run.account.archivedAt ? 'Sub-account archived' : 'Workflow switched off' })
    await finish('cancelled', run.step)
    return
  }

  const steps = asSteps(run.workflow.steps)
  const linked = isLinked(steps)
  const indexOf = new Map(steps.map((s, i) => [s.id, i]))
  const indexFor = (id: string | null | undefined) => (id ? (indexOf.get(id) ?? steps.length) : steps.length)
  const after = (i: number, r: StepResult) => (r.goto !== undefined ? indexFor(r.goto) : !linked || steps[i].next === undefined ? i + 1 : indexFor(steps[i].next))

  const appointment = await loadAppointment(context.appointmentId, run.account.timezone)
  const ctx: Ctx = {
    runId,
    workflowId: run.workflowId,
    accountId: run.accountId,
    timezone: run.account.timezone,
    contact: run.contact,
    depth,
    startedAt: run.createdAt,
    context,
    delayed: log.some((l) => WAITS.has(l.type)),
    appointment,
    merge: {
      contact: run.contact,
      account: readProfile(run.account.profile),
      form: (context.form as Record<string, unknown>) ?? null,
      call: (context.call as Record<string, unknown>) ?? null,
      appointment,
      links: { review: trackedLink(run.contact.id, 'review') },
    },
  }

  let i = run.step
  let hops = 0
  while (i < steps.length) {
    if (++hops > MAX_HOPS) {
      log.push({ at: new Date().toISOString(), step: i, type: 'stop', ok: false, detail: 'Stopped: the workflow keeps going round without a wait' })
      await finish('failed', i)
      return
    }
    let r: StepResult
    try {
      r = await runStep(steps[i], ctx, i)
    } catch (err) {
      r = { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
    log.push({ at: new Date().toISOString(), step: i, type: steps[i].type, ok: r.ok, detail: r.detail })
    if (r.waitUntil) {
      if (WAITS.has(steps[i].type)) ctx.delayed = true
      await finish('waiting', r.retryStep ? i : after(i, r), { nextRunAt: r.waitUntil })
      return
    }
    if (r.stop) {
      await finish('done', steps.length)
      return
    }
    // The contact may have changed (tags, consent); later steps read it fresh.
    const fresh = await prisma.hlContact.findUnique({ where: { id: run.contactId } })
    if (!fresh) {
      log.push({ at: new Date().toISOString(), step: i, type: 'stop', ok: false, detail: 'Contact deleted' })
      await finish('cancelled', i + 1)
      return
    }
    ctx.contact = fresh
    ctx.merge.contact = fresh
    i = after(i, r)
  }
  await finish('done', steps.length)
}

/**
 * A contact texted in. Runs waiting for their reply carry on now; runs of
 * workflows set to "Stop on response" (GHL's setting) end. Runs the reply
 * itself started are left alone.
 */
export async function contactReplied(accountId: string, contactId: string, at: Date): Promise<void> {
  const runs = await prisma.hlWorkflowRun.findMany({
    where: { accountId, contactId, status: 'waiting', createdAt: { lt: at } },
    include: { workflow: { select: { meta: true } } },
  })
  for (const r of runs) {
    if (rec(r.context).replyWait) {
      await prisma.hlWorkflowRun.updateMany({ where: { id: r.id, status: 'waiting' }, data: { nextRunAt: new Date() } })
      await advanceRun(r.id).catch((err) => console.error(`[hell-level] resume ${r.id} after reply failed:`, err))
    } else if (rec(r.workflow.meta).stopOnResponse === true) {
      const log = [...((Array.isArray(r.log) ? r.log : []) as LogLine[]), { at: new Date().toISOString(), step: r.step, type: 'stop', ok: true, detail: 'The contact replied: stopped (Stop on response)' }]
      await prisma.hlWorkflowRun.updateMany({
        where: { id: r.id, status: 'waiting' },
        data: { status: 'done', nextRunAt: null, lockedAt: null, log: log as unknown as Prisma.InputJsonValue },
      })
    }
  }
}

/** Resume parked runs whose wait is over. Called by the scheduler every minute. */
export async function resumeDueRuns(limit = 50): Promise<number> {
  const due = await prisma.hlWorkflowRun.findMany({
    where: { status: 'waiting', nextRunAt: { lte: new Date() } },
    orderBy: { nextRunAt: 'asc' },
    take: limit,
    select: { id: true },
  })
  for (const r of due) await advanceRun(r.id).catch((err) => console.error(`[hell-level] resume ${r.id} failed:`, err))
  return due.length
}

/** Runs left "running" by a container that died mid-step: put them back in the queue. */
export async function recoverStuckRuns(): Promise<number> {
  const stale = new Date(Date.now() - LOCK_MS)
  // Locked by a worker that never finished, or created and never picked up (the process died in between).
  const r = await prisma.hlWorkflowRun.updateMany({
    where: { status: 'running', OR: [{ lockedAt: { lt: stale } }, { lockedAt: null, updatedAt: { lt: stale } }] },
    data: { status: 'waiting', nextRunAt: new Date(), lockedAt: null },
  })
  return r.count
}

/**
 * Put one contact through one workflow by hand ("Add to workflow" / "Test"),
 * whatever its trigger, published or not. Context fills {{form.*}} with the
 * contact's saved form answers so a test reads like the real thing.
 */
export async function startWorkflow(workflowId: string, contactId: string): Promise<string> {
  const [w, contact] = await Promise.all([
    prisma.hlWorkflow.findUnique({ where: { id: workflowId } }),
    prisma.hlContact.findUnique({ where: { id: contactId } }),
  ])
  if (!w || !contact || contact.accountId !== w.accountId) throw new Error('Workflow or contact not found in this sub-account')
  // A draft runs too when started by hand (`manual: true`): that's how a new workflow gets tested.
  const run = await prisma.hlWorkflowRun.create({
    data: { workflowId, accountId: w.accountId, contactId, context: { trigger: 'manual', manual: true, form: contact.fields ?? {} } as Prisma.InputJsonValue },
    select: { id: true },
  })
  await advanceRun(run.id)
  return run.id
}

/** Stop a contact's run (manual "remove from workflow"). */
export async function cancelRun(runId: string): Promise<void> {
  await prisma.hlWorkflowRun.updateMany({ where: { id: runId, status: { in: ['running', 'waiting'] } }, data: { status: 'cancelled', lockedAt: null, nextRunAt: null } })
}
