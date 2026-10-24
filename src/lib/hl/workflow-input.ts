import { HlInputError } from './http'
import { APPOINTMENT_STATUSES, STEPS, TRIGGERS, type HlBranch, type HlCondition, type HlStep, type HlTrigger } from './types'

const s = (v: unknown, max = 1600) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const list = (v: unknown) => (Array.isArray(v) ? v : [])

/** A trigger from the builder, with only the keys its type uses (and an imported one's GHL details). */
export function cleanTrigger(raw: unknown): HlTrigger {
  const t = rec(raw)
  const type = TRIGGERS.find((x) => x.type === t.type)?.type
  if (!type) throw new HlInputError('Pick a trigger.')
  const out: HlTrigger = { type }
  if (s(t.id, 60)) out.id = s(t.id, 60)
  if (s(t.name, 120)) out.name = s(t.name, 120)
  if (t.active === false) out.active = false
  if (type === 'form_submitted' || type === 'chat_submitted') {
    out.formId = s(t.formId)
    const ids = list(t.formIds).map((x) => s(x, 60)).filter((x): x is string => !!x)
    if (ids.length) out.formIds = ids
  }
  if (type === 'inbound_sms') {
    out.keyword = s(t.keyword, 200)
    if (t.match === 'exact') out.match = 'exact'
  }
  if (type === 'tag_added') out.tag = s(t.tag)?.toLowerCase()
  if (type === 'opportunity_stage' || type === 'opportunity_created') {
    out.stageId = s(t.stageId)
    out.pipelineId = s(t.pipelineId)
  }
  if (type === 'appointment_booked' || type === 'appointment_status') out.calendarId = s(t.calendarId)
  if (type === 'appointment_status') out.status = (APPOINTMENT_STATUSES as readonly string[]).includes(String(t.status)) ? String(t.status) : undefined
  const ghl = rec(t.ghl)
  if (s(ghl.type, 80)) out.ghl = { type: s(ghl.type, 80)!, conditions: list(ghl.conditions).slice(0, 30) }
  return out
}

/** Every trigger of a workflow (GHL ones can have several); at least one. */
export function cleanTriggers(raw: unknown): HlTrigger[] {
  const out = list(raw).slice(0, 20).map(cleanTrigger)
  if (!out.length) throw new HlInputError('Add a trigger.')
  return out
}

const condition = (c: Record<string, unknown>): HlCondition => ({
  type: s(c.type, 60) ?? 'unknown',
  ...(s(c.subType, 120) ? { subType: s(c.subType, 120) } : {}),
  operator: s(c.operator, 40) ?? '==',
  value: typeof c.value === 'string' ? c.value.slice(0, 500) : Array.isArray(c.value) ? c.value.slice(0, 50) : c.value,
})

const branch = (b: Record<string, unknown>, i: number): HlBranch => ({
  id: s(b.id, 60) ?? `b${Date.now().toString(36)}${i}`,
  name: s(b.name, 120) ?? `Branch ${i + 1}`,
  operator: b.operator === 'or' ? 'or' : 'and',
  segments: list(b.segments)
    .slice(0, 20)
    .map(rec)
    .map((seg) => ({ operator: seg.operator === 'or' ? ('or' as const) : ('and' as const), conditions: list(seg.conditions).slice(0, 30).map(rec).map(condition) })),
  next: s(b.next, 60) ?? null,
})

const amountIn = (v: unknown, min: number, i: number) => {
  const n = Math.round(Number(v) * 100) / 100
  if (!(n >= min && n <= 365)) throw new HlInputError(`Step ${i + 1}: wait between ${min || 'a moment'} and 365.`)
  return n
}
const unitOf = (v: unknown) => (v === 'days' || v === 'hours' ? v : 'minutes')
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
/** A wait's business-hours window, if it has a usable one. */
const windowOf = (v: unknown): HlStep['config']['window'] | undefined => {
  const w = rec(v)
  const days = [...new Set(list(w.days).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
  const start = s(w.start, 5)
  const end = s(w.end, 5)
  return days.length && start && end && HHMM.test(start) && HHMM.test(end) && start < end ? { days, start, end } : undefined
}
const pathsOf = (v: unknown) =>
  list(v)
    .slice(0, 10)
    .map(rec)
    .map((p, j) => ({ id: s(p.id, 60) ?? `p${j}`, name: s(p.name, 60) ?? `Path ${j + 1}`, percent: Math.max(0, Math.min(100, Number(p.percent) || 0)), next: s(p.next, 60) ?? null }))
const tagsOf = (c: Record<string, unknown>) =>
  [...list(c.tags), c.tag]
    .map((t) => s(t, 60)?.toLowerCase())
    .filter((t): t is string => !!t)

/**
 * Steps from the builder: known types only, each with an id, config trimmed
 * to what the type reads. Linked steps (from GHL) keep their links, and a
 * link to a step that's gone becomes "the end".
 */
export function cleanSteps(raw: unknown): HlStep[] {
  if (!Array.isArray(raw)) throw new HlInputError('Steps must be a list.')
  if (raw.length > 400) throw new HlInputError('That’s a lot of steps: 400 at most.')
  const steps = raw.map((r, i): HlStep => {
    const step = rec(r)
    const type = STEPS.find((x) => x.type === step.type)?.type
    if (!type) throw new HlInputError(`Step ${i + 1} has an unknown action.`)
    const c = rec(step.config)
    const id = s(step.id, 60) ?? `s${Date.now().toString(36)}${i}`
    const name = s(step.name, 120)
    const links: Partial<HlStep> = {}
    if (step.next !== undefined) links.next = s(step.next, 60) ?? null
    const ghl = rec(step.ghl)
    if (s(ghl.type, 80)) links.ghl = { type: s(ghl.type, 80)!, ...(type === 'ghl' || type === 'drip' ? { attributes: ghl.attributes } : {}) }
    const out = (config: HlStep['config']): HlStep => ({ id, type, name, config, ...links })
    switch (type) {
      case 'send_sms':
      case 'internal_sms':
        if (!s(c.body)) throw new HlInputError(`Step ${i + 1}: write the message.`)
        return out({ body: s(c.body), ...(type === 'internal_sms' && s(c.to, 200) ? { to: s(c.to, 200) } : {}) })
      case 'internal_email':
        if (!s(c.body, 8000)) throw new HlInputError(`Step ${i + 1}: write the email.`)
        return out({ subject: s(c.subject, 200) ?? '', body: s(c.body, 8000), ...(s(c.to, 300) ? { to: s(c.to, 300) } : {}) })
      case 'send_email':
        return out({ subject: s(c.subject, 300) ?? '', body: typeof c.body === 'string' ? c.body.slice(0, 200_000) : '', ...(s(c.fromName, 120) ? { fromName: s(c.fromName, 120) } : {}) })
      case 'wait': {
        const window = windowOf(c.window)
        return out({ amount: amountIn(c.amount, 0, i), unit: unitOf(c.unit), ...(window ? { window } : {}) })
      }
      case 'wait_reply':
        // 0 = no time limit: carries on only when they reply.
        return out({ amount: amountIn(c.amount, 0, i), unit: unitOf(c.unit) })
      case 'wait_appointment':
        return out({ amount: amountIn(c.amount, 0, i), unit: unitOf(c.unit), when: c.when === 'after' ? 'after' : 'before' })
      case 'add_tag':
      case 'remove_tag': {
        const tags = tagsOf(c)
        if (!tags.length) throw new HlInputError(`Step ${i + 1}: name the tag.`)
        return out(tags.length === 1 && !Array.isArray(c.tags) ? { tag: tags[0] } : { tags })
      }
      case 'if_tag':
        if (!s(c.tag, 60)) throw new HlInputError(`Step ${i + 1}: name the tag to check.`)
        return out({ tag: s(c.tag, 60)!.toLowerCase(), has: c.has !== false })
      case 'create_opportunity':
      case 'move_opportunity':
        if (type === 'move_opportunity' && !s(c.stageId)) throw new HlInputError(`Step ${i + 1}: pick the stage to move to.`)
        return out({ ...(s(c.pipelineId) ? { pipelineId: s(c.pipelineId) } : {}), ...(s(c.stageId) ? { stageId: s(c.stageId) } : {}) })
      case 'if_else':
        return { ...out({}), branches: list(step.branches).slice(0, 20).map(rec).map(branch), elseNext: s(step.elseNext, 60) ?? null, elseName: s(step.elseName, 120) ?? 'None' }
      case 'goto':
        return out({ ...(s(c.target, 60) ? { target: s(c.target, 60) } : {}) })
      case 'split':
        return out({ paths: pathsOf(c.paths) })
      case 'dnd':
        return out({ dnd: c.dnd !== false })
      case 'update_field':
      case 'update_contact':
        return out({
          fields: list(c.fields)
            .slice(0, 30)
            .map(rec)
            .filter((f) => s(f.key, 80))
            .map((f) => ({ key: s(f.key, 80)!, ...(s(f.label, 120) ? { label: s(f.label, 120) } : {}), value: typeof f.value === 'string' ? f.value.slice(0, 2000) : '' })),
        })
      case 'add_note':
        if (!s(c.body, 8000)) throw new HlInputError(`Step ${i + 1}: write the note.`)
        return out({ body: s(c.body, 8000) })
      case 'add_to_workflow':
      case 'remove_from_workflow':
        return out({ workflowIds: list(c.workflowIds).map((x) => s(x, 60)).filter((x): x is string => !!x) })
      case 'drip':
        return out({})
      case 'ghl': {
        const paths = pathsOf(c.paths)
        return out(paths.length ? { paths } : {})
      }
    }
  })
  // Links to a step that isn't there any more end the path instead.
  const ids = new Set(steps.map((x) => x.id))
  const keep = (v: string | null | undefined) => (v && ids.has(v) ? v : null)
  for (const x of steps) {
    if (x.next !== undefined) x.next = keep(x.next)
    if (x.type === 'if_else') {
      x.branches = (x.branches ?? []).map((b) => ({ ...b, next: keep(b.next) }))
      x.elseNext = keep(x.elseNext)
    }
    if (x.type === 'goto' && x.config.target && !ids.has(x.config.target)) delete x.config.target
    if (x.config.paths) x.config.paths = x.config.paths.map((p) => ({ ...p, next: keep(p.next) }))
  }
  return steps
}
