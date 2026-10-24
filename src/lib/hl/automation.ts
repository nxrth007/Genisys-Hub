import { toZonedTime, fromZonedTime } from 'date-fns-tz'
import { prisma } from '@/lib/prisma'
import type { HlContact, HlWorkflow, Prisma } from '@/generated/prisma/client'
import { readProfile } from './accounts'
import { addTags, removeTags } from './contacts'
import { renderTemplate, type MergeData } from './merge'
import { sendInternalEmail, sendInternalSms, sendSmsToContact } from './messages'
import { emailList, phoneList } from './phone'
import type { HlStage, HlStep, HlTrigger, HlTriggerType } from './types'

/**
 * The workflow engine. A trigger (form sent, missed call, reply…) starts a
 * run for each published workflow that listens for it; a run walks the
 * workflow's steps in order until a Wait, which parks it with nextRunAt.
 * The scheduler resumes parked runs every minute (resumeDueRuns).
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
  /** Saved on the run for merge fields: { form: {...} } / { call: {...} }. */
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

const asTrigger = (v: unknown) => (v ?? {}) as HlTrigger
export const asSteps = (v: unknown) => (Array.isArray(v) ? (v as HlStep[]) : [])

function matches(w: HlWorkflow, e: TriggerEvent): boolean {
  const t = asTrigger(w.trigger)
  if (t.type !== e.type) return false
  if ((t.type === 'form_submitted' || t.type === 'chat_submitted') && t.formId && t.formId !== e.formId) return false
  if (t.type === 'inbound_sms' && t.keyword?.trim() && !(e.text ?? '').toLowerCase().includes(t.keyword.trim().toLowerCase())) return false
  if (t.type === 'tag_added' && t.tag?.trim() && t.tag.trim().toLowerCase() !== (e.tag ?? '').toLowerCase()) return false
  if (t.type === 'opportunity_stage' && t.stageId && t.stageId !== e.stageId) return false
  return true
}

/** Start every published workflow of the sub-account that listens for this event. Returns how many started. */
export async function fireTrigger(accountId: string, contactId: string, e: TriggerEvent, depth = 0): Promise<number> {
  if (depth > MAX_DEPTH) return 0
  const workflows = await prisma.hlWorkflow.findMany({ where: { accountId, status: 'published', deletedAt: null }, orderBy: { createdAt: 'asc' } })
  let started = 0
  for (const w of workflows.filter((x) => matches(x, e))) {
    const earlier = await prisma.hlWorkflowRun.findFirst({
      where: { workflowId: w.id, contactId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, status: true },
    })
    if (earlier && Date.now() - earlier.createdAt.getTime() < DUPLICATE_MS) continue
    if (earlier && !w.allowReentry) continue
    const run = await prisma.hlWorkflowRun.create({
      data: { workflowId: w.id, accountId, contactId, context: { trigger: e.type, ...(e.context ?? {}) } as Prisma.InputJsonValue },
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
  accountId: string
  timezone: string
  contact: HlContact
  merge: MergeData
  depth: number
  /** True once the run has waited at least once: its texts are no longer an instant reply. */
  delayed: boolean
}

type StepResult = { ok: boolean; detail: string; waitUntil?: Date; stop?: boolean; retryStep?: boolean }

async function runStep(step: HlStep, c: Ctx): Promise<StepResult> {
  const cfg = step.config ?? {}
  const render = (s: string | undefined) => renderTemplate(s ?? '', c.merge)
  const profile = c.merge.account ?? {}
  switch (step.type) {
    case 'send_sms': {
      if (c.delayed && inQuietHours(c.timezone)) {
        return { ok: true, detail: 'Quiet hours: waiting until 9 AM', waitUntil: nextMorning(c.timezone), retryStep: true }
      }
      const r = await sendSmsToContact({ accountId: c.accountId, contactId: c.contact.id, body: render(cfg.body), by: 'automation', runId: c.runId })
      return { ok: r.ok, detail: r.detail }
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
      const amount = Math.max(1, Number(cfg.amount) || 1)
      const ms = (cfg.unit === 'days' ? 86_400_000 : cfg.unit === 'hours' ? 3_600_000 : 60_000) * amount
      return { ok: true, detail: `Waiting ${amount} ${cfg.unit ?? 'minutes'}`, waitUntil: new Date(Date.now() + ms) }
    }
    case 'add_tag': {
      const tag = render(cfg.tag).trim().toLowerCase()
      if (!tag) return { ok: false, detail: 'No tag set' }
      const fresh = await addTags(c.contact.id, [tag])
      if (fresh.length) await fireTrigger(c.accountId, c.contact.id, { type: 'tag_added', tag }, c.depth + 1)
      return { ok: true, detail: fresh.length ? `Tagged “${tag}”` : `Already tagged “${tag}”` }
    }
    case 'remove_tag': {
      const tag = render(cfg.tag).trim().toLowerCase()
      await removeTags(c.contact.id, [tag])
      return { ok: true, detail: `Removed “${tag}”` }
    }
    case 'create_opportunity': {
      const pipeline = cfg.pipelineId
        ? await prisma.hlPipeline.findFirst({ where: { id: cfg.pipelineId, accountId: c.accountId } })
        : await prisma.hlPipeline.findFirst({ where: { accountId: c.accountId }, orderBy: { createdAt: 'asc' } })
      if (!pipeline) return { ok: false, detail: 'The sub-account has no pipeline' }
      const stages = (pipeline.stages as HlStage[]) ?? []
      const stage = stages.find((s) => s.id === cfg.stageId) ?? stages[0]
      if (!stage) return { ok: false, detail: 'The pipeline has no stages' }
      const open = await prisma.hlOpportunity.findFirst({ where: { contactId: c.contact.id, pipelineId: pipeline.id, status: 'open' } })
      if (open) return { ok: true, detail: 'Already has an open opportunity in this pipeline' }
      const last = await prisma.hlOpportunity.findFirst({ where: { pipelineId: pipeline.id, stageId: stage.id }, orderBy: { position: 'desc' }, select: { position: true } })
      const c0 = c.contact
      await prisma.hlOpportunity.create({
        data: {
          accountId: c.accountId,
          pipelineId: pipeline.id,
          stageId: stage.id,
          contactId: c0.id,
          name: [c0.firstName, c0.lastName].filter(Boolean).join(' ') || c0.phone || c0.email || 'New lead',
          source: c0.source,
          position: (last?.position ?? 0) + 1,
        },
      })
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
      await fireTrigger(c.accountId, c.contact.id, { type: 'opportunity_stage', stageId: stage.id }, c.depth + 1)
      return { ok: true, detail: `Moved to ${stage.name}` }
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
    default:
      return { ok: false, detail: `Unknown step “${(step as HlStep).type}”` }
  }
}

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
  const finish = (status: string, step: number, extra: Partial<{ nextRunAt: Date | null }> = {}) =>
    prisma.hlWorkflowRun.update({
      where: { id: runId },
      data: { status, step, lockedAt: null, log: log as unknown as Prisma.InputJsonValue, nextRunAt: extra.nextRunAt ?? null },
    })

  const manual = (run.context as Record<string, unknown> | null)?.manual === true
  if (run.account.archivedAt || (run.workflow.status !== 'published' && !manual)) {
    log.push({ at: now.toISOString(), step: run.step, type: 'stop', ok: true, detail: run.account.archivedAt ? 'Sub-account archived' : 'Workflow switched off' })
    await finish('cancelled', run.step)
    return
  }

  const steps = asSteps(run.workflow.steps)
  const context = (run.context ?? {}) as Record<string, unknown>
  const ctx: Ctx = {
    runId,
    accountId: run.accountId,
    timezone: run.account.timezone,
    contact: run.contact,
    depth,
    delayed: log.some((l) => l.type === 'wait'),
    merge: {
      contact: run.contact,
      account: readProfile(run.account.profile),
      form: (context.form as Record<string, unknown>) ?? null,
      call: (context.call as Record<string, unknown>) ?? null,
    },
  }

  for (let i = run.step; i < steps.length; i++) {
    let r: StepResult
    try {
      r = await runStep(steps[i], ctx)
    } catch (err) {
      r = { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
    log.push({ at: new Date().toISOString(), step: i, type: steps[i].type, ok: r.ok, detail: r.detail })
    if (r.waitUntil) {
      if (steps[i].type === 'wait') ctx.delayed = true
      await finish('waiting', r.retryStep ? i : i + 1, { nextRunAt: r.waitUntil })
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
  }
  await finish('done', steps.length)
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
