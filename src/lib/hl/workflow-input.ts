import { HlInputError } from './http'
import { STEPS, TRIGGERS, type HlStep, type HlTrigger } from './types'

/** A trigger from the builder, with only the keys its type uses. */
export function cleanTrigger(raw: unknown): HlTrigger {
  const t = (raw ?? {}) as Record<string, unknown>
  const type = TRIGGERS.find((x) => x.type === t.type)?.type
  if (!type) throw new HlInputError('Pick a trigger.')
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const out: HlTrigger = { type }
  if (type === 'form_submitted' || type === 'chat_submitted') out.formId = s(t.formId)
  if (type === 'inbound_sms') out.keyword = s(t.keyword)
  if (type === 'tag_added') out.tag = s(t.tag)?.toLowerCase()
  if (type === 'opportunity_stage') out.stageId = s(t.stageId)
  return out
}

/** Steps from the builder: known types only, each with an id, config trimmed to what the type reads. */
export function cleanSteps(raw: unknown): HlStep[] {
  if (!Array.isArray(raw)) throw new HlInputError('Steps must be a list.')
  if (raw.length > 50) throw new HlInputError('That’s a lot of steps: 50 at most.')
  return raw.map((r, i) => {
    const step = (r ?? {}) as Record<string, unknown>
    const type = STEPS.find((x) => x.type === step.type)?.type
    if (!type) throw new HlInputError(`Step ${i + 1} has an unknown action.`)
    const c = (step.config ?? {}) as Record<string, unknown>
    const s = (v: unknown, max = 1600) => (typeof v === 'string' ? v.slice(0, max) : undefined)
    const id = typeof step.id === 'string' && step.id ? step.id.slice(0, 40) : `s${Date.now().toString(36)}${i}`
    const name = s(step.name, 80)?.trim() || undefined
    switch (type) {
      case 'send_sms':
      case 'internal_sms':
        if (!s(c.body)?.trim()) throw new HlInputError(`Step ${i + 1}: write the message.`)
        return { id, type, name, config: { body: s(c.body), ...(type === 'internal_sms' && s(c.to)?.trim() ? { to: s(c.to, 200) } : {}) } }
      case 'internal_email':
        if (!s(c.body, 8000)?.trim()) throw new HlInputError(`Step ${i + 1}: write the email.`)
        return { id, type, name, config: { subject: s(c.subject, 200) ?? '', body: s(c.body, 8000), ...(s(c.to)?.trim() ? { to: s(c.to, 300) } : {}) } }
      case 'wait': {
        const amount = Math.round(Number(c.amount))
        if (!(amount >= 1 && amount <= 365)) throw new HlInputError(`Step ${i + 1}: wait between 1 and 365.`)
        const unit = c.unit === 'days' || c.unit === 'hours' ? c.unit : 'minutes'
        return { id, type, name, config: { amount, unit } }
      }
      case 'add_tag':
      case 'remove_tag':
        if (!s(c.tag, 60)?.trim()) throw new HlInputError(`Step ${i + 1}: name the tag.`)
        return { id, type, name, config: { tag: s(c.tag, 60)!.trim().toLowerCase() } }
      case 'if_tag':
        if (!s(c.tag, 60)?.trim()) throw new HlInputError(`Step ${i + 1}: name the tag to check.`)
        return { id, type, name, config: { tag: s(c.tag, 60)!.trim().toLowerCase(), has: c.has !== false } }
      case 'create_opportunity':
      case 'move_opportunity':
        if (type === 'move_opportunity' && !s(c.stageId)) throw new HlInputError(`Step ${i + 1}: pick the stage to move to.`)
        return { id, type, name, config: { ...(s(c.pipelineId) ? { pipelineId: s(c.pipelineId) } : {}), ...(s(c.stageId) ? { stageId: s(c.stageId) } : {}) } }
    }
  })
}
