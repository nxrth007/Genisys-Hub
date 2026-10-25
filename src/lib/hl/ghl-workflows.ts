import { randomBytes, timingSafeEqual } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { HlInputError } from './http'
import type { HlBranch, HlCondition, HlStep, HlTrigger } from './types'
import { ghlWebhookConfig } from './ghl-webhook-step'
import { ensureHookIds } from './webhooks'

/**
 * GoHighLevel workflows as they really are: the folders, every trigger, and
 * the steps with their if/else branches, waits and go-tos. GHL's public API
 * only lists workflow names, so the definitions come from GHL's own app: in
 * a browser signed in to the sub-account, a copy script reads them with that
 * session and posts them here with a one-time key (createExportKey). They're
 * kept as sent, so the import can be run again (reimportSaved) as Hell-level
 * learns more of GHL's actions, then turned into Hell-level workflows: the
 * same folders, names and on/off status, linked steps, and a "GoHighLevel
 * action" step (shown as it was, a run stops there) for what Hell-level
 * can't run yet.
 */

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
const json = (v: unknown) => v as Prisma.InputJsonValue

export type GhlTreeItem = { id: string; name: string; type: string; status?: string | null; parentId?: string | null }
export type GhlExport = { locationId?: string; tree: GhlTreeItem[]; workflows: Record<string, { def: unknown; trig: unknown }> }

export type GhlWorkflowImport = {
  folders: number
  workflows: number
  published: number
  steps: number
  /** GHL actions Hell-level shows but can't run yet, by GHL type. */
  unsupported: Record<string, number>
  /** GHL triggers that never fire here (no equivalent), by GHL type. */
  idleTriggers: Record<string, number>
}

// ---------------------------------------------------------------------------
// Getting the export here: a one-time key for the copy script
// ---------------------------------------------------------------------------

const KEY_SETTING = 'hl.ghlwf.key'
const RAW_SETTING = (accountId: string) => `hl.ghlwf.raw.${accountId}`
const KEY_MS = 30 * 60_000

/** A key the copy script in GHL's tab sends with the export. One use, 30 minutes. */
export async function createExportKey(accountId: string, by: string): Promise<{ key: string; expiresAt: string }> {
  const account = await prisma.hlAccount.findUnique({ where: { id: accountId }, select: { id: true } })
  if (!account) throw new HlInputError('Sub-account not found.')
  const key = randomBytes(24).toString('base64url')
  const expiresAt = new Date(Date.now() + KEY_MS).toISOString()
  const value = JSON.stringify({ key, accountId, expiresAt, by })
  await prisma.appSetting.upsert({ where: { key: KEY_SETTING }, create: { key: KEY_SETTING, value }, update: { value } })
  return { key, expiresAt }
}

function sameKey(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** The copy script's post: check the key (then spend it), keep the export, import it. */
export async function receiveExport(key: string, body: unknown): Promise<{ accountId: string; result: GhlWorkflowImport }> {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY_SETTING } })
  let saved: { key?: string; accountId?: string; expiresAt?: string } = {}
  try {
    saved = JSON.parse(row?.value ?? '{}')
  } catch {
    // no key
  }
  if (!saved.key || !saved.accountId || !key || !sameKey(key, saved.key)) throw new HlInputError('That copy key isn’t valid. Make a new one in Hell-level.')
  if (!saved.expiresAt || new Date(saved.expiresAt).getTime() < Date.now()) throw new HlInputError('That copy key has expired. Make a new one in Hell-level.')
  await prisma.appSetting.delete({ where: { key: KEY_SETTING } })
  const x = readExport(body)
  const raw = JSON.stringify(x)
  await prisma.appSetting.upsert({ where: { key: RAW_SETTING(saved.accountId) }, create: { key: RAW_SETTING(saved.accountId), value: raw }, update: { value: raw } })
  return { accountId: saved.accountId, result: await importGhlWorkflows(saved.accountId, x) }
}

/** Run the import again from the export already here (after Hell-level learns more of GHL's actions). */
export async function reimportSaved(accountId: string): Promise<GhlWorkflowImport> {
  const row = await prisma.appSetting.findUnique({ where: { key: RAW_SETTING(accountId) } })
  if (!row) throw new HlInputError('Nothing copied from GoHighLevel for this sub-account yet.')
  return importGhlWorkflows(accountId, readExport(JSON.parse(row.value)))
}

function readExport(body: unknown): GhlExport {
  const b = rec(body)
  const tree = arr(b.tree)
    .map(rec)
    .map((t) => ({ id: str(t.id) ?? '', name: str(t.name) ?? 'Untitled', type: str(t.type) ?? 'workflow', status: str(t.status), parentId: str(t.parentId) }))
    .filter((t) => t.id)
  const workflows = rec(b.workflows) as GhlExport['workflows']
  if (!tree.length || !Object.keys(workflows).length) throw new HlInputError('The copy had no workflows in it.')
  return { locationId: str(b.locationId) ?? undefined, tree, workflows }
}

// ---------------------------------------------------------------------------
// Turning GHL's definitions into Hell-level's
// ---------------------------------------------------------------------------

type Refs = {
  pipelines: Map<string, string>
  calendars: Map<string, string>
  forms: Map<string, string>
  workflows: Map<string, string>
  /** GHL custom field id → the key contacts' fields are saved under. */
  fieldKeys: Map<string, string>
}

const UNIT: Record<string, 'minutes' | 'hours' | 'days'> = { minute: 'minutes', minutes: 'minutes', min: 'minutes', hour: 'hours', hours: 'hours', day: 'days', days: 'days' }

/** Folder id → "Parent/Child/Grandchild" (a "/" inside a name becomes "∕" so the path splits cleanly). */
export function folderPaths(tree: GhlTreeItem[]): Map<string, string> {
  const byId = new Map(tree.map((t) => [t.id, t]))
  const memo = new Map<string, string>()
  const pathOf = (id: string, depth = 0): string => {
    const known = memo.get(id)
    if (known !== undefined) return known
    const t = byId.get(id)
    if (!t || t.type !== 'directory' || depth > 20) return ''
    const parent = t.parentId && byId.get(t.parentId)?.type === 'directory' ? pathOf(t.parentId, depth + 1) : ''
    const p = [parent, t.name.trim().replace(/\//g, '∕')].filter(Boolean).join('/')
    memo.set(id, p)
    return p
  }
  for (const t of tree) if (t.type === 'directory') pathOf(t.id)
  return memo
}

const condition = (c: Rec): HlCondition => ({
  type: str(c.conditionType) ?? 'unknown',
  subType: str(c.conditionSubType) ?? undefined,
  operator: str(c.conditionOperator) ?? '==',
  value: c.conditionValue,
})

const plainText = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

/** GHL's linked templates → Hell-level steps (same ids, same links). */
export function convertSteps(templates: Rec[], refs: Refs): { steps: HlStep[]; unsupported: string[] } {
  const byId = new Map(templates.map((t) => [String(t.id), t]))
  const isBranchNode = (t: Rec) =>
    t.type === 'if_else' && (t.nodeType === 'branch-yes' || t.nodeType === 'branch-no' || (!!t.parent && !arr(rec(t.attributes).branches).length))
  const structural = (t: Rec) => t.type === 'transition' || isBranchNode(t)
  // A link to a branch or path marker means the first step after it.
  const resolve = (id: unknown, guard = 0): string | null => {
    const s = str(id)
    if (!s) return null
    const t = byId.get(s)
    if (!t) return null
    return structural(t) ? (guard < 20 ? resolve(Array.isArray(t.next) ? null : t.next, guard + 1) : null) : s
  }
  const ordered = [...templates].sort((a, b) => (num(a.order) ?? 0) - (num(b.order) ?? 0))
  // The start: the first step nothing leads into.
  const pointedAt = new Set<string>()
  for (const t of templates) {
    for (const n of Array.isArray(t.next) ? t.next : [t.next]) if (str(n)) pointedAt.add(String(n))
  }
  const start = ordered.find((t) => !structural(t) && !pointedAt.has(String(t.id)) && !t.parentKey) ?? ordered.find((t) => !structural(t))
  const unsupported: string[] = []
  const steps: HlStep[] = []

  for (const t of ordered) {
    if (structural(t)) continue
    const a = rec(t.attributes)
    const id = String(t.id)
    // The name GHL shows: an If/Else's is its condition name (every one is called "yes" inside); newer
    // actions (Split, Find Contact) keep theirs in attributes, with an i18n key or a stock label as `name`.
    const own = str(a.name)
    const name =
      (t.type === 'if_else' ? str(a.conditionName) : null) ??
      (own && !own.includes('{{') && (!str(t.name) || /^[\w-]+(\.[\w-]+)+$/.test(str(t.name)!) || t.type === 'find_contact' || t.type === 'workflow_split') ? own : null) ??
      str(t.name) ??
      undefined
    const next = Array.isArray(t.next) ? null : resolve(t.next)
    const base = { id, name, next }
    const ghl = { type: String(t.type) }
    let step: HlStep
    switch (t.type) {
      case 'sms':
        step = { ...base, type: 'send_sms', config: { body: str(a.body) ?? '' }, ghl }
        break
      case 'email':
        step = { ...base, type: 'send_email', config: { subject: str(a.subject) ?? '', body: String(a.html ?? a.body ?? ''), fromName: str(a.from_name) ?? undefined }, ghl }
        break
      case 'internal_notification': {
        const kind = str(a.type)
        const part = rec(kind === 'email' ? a.email : a.sms)
        const custom = /custom/i.test(str(part.userType) ?? '')
        if (kind === 'sms') step = { ...base, type: 'internal_sms', config: { body: str(part.body) ?? '', to: custom ? (str(part.to) ?? '') : '' }, ghl }
        else if (kind === 'email') step = { ...base, type: 'internal_email', config: { subject: str(part.subject) ?? '', body: plainText(String(part.html ?? part.body ?? '')), to: custom ? (str(part.to) ?? '') : '' }, ghl }
        else step = { ...base, type: 'ghl', config: {}, ghl: { type: `internal_notification:${kind}`, attributes: a } }
        break
      }
      case 'wait': {
        const after = rec(a.startAfter)
        // GHL can count in seconds; Hell-level's smallest unit is minutes.
        const seconds = /^sec/i.test(str(after.type) ?? '')
        const amount = seconds ? Math.round(((num(after.value) ?? 0) / 60) * 100) / 100 : (num(after.value) ?? 0)
        const unit = seconds ? 'minutes' : (UNIT[str(after.type) ?? ''] ?? 'minutes')
        const kind = str(a.type)
        const w = rec(a.window)
        const days = arr(w.days).map(num).filter((d): d is number => d !== null && d >= 0 && d <= 6)
        const window = days.length && str(w.start) && str(w.end) ? { days, start: str(w.start)!, end: str(w.end)! } : undefined
        if (kind === 'time') step = { ...base, type: 'wait', config: { amount, unit, ...(window ? { window } : {}) }, ghl }
        else if (kind === 'appointment') step = { ...base, type: 'wait_appointment', config: { amount, unit, when: str(after.when) === 'after' ? 'after' : 'before' }, ghl }
        else if (kind === 'reply') step = { ...base, type: 'wait_reply', config: { amount, unit }, ghl }
        else step = { ...base, type: 'ghl', config: {}, ghl: { type: `wait:${kind}`, attributes: a } }
        break
      }
      case 'add_contact_tag':
        step = { ...base, type: 'add_tag', config: { tags: arr(a.tags).map(str).filter((x): x is string => !!x) }, ghl }
        break
      case 'remove_contact_tag':
        step = { ...base, type: 'remove_tag', config: { tags: arr(a.tags).map(str).filter((x): x is string => !!x) }, ghl }
        break
      case 'create_opportunity':
        step = {
          ...base,
          type: 'create_opportunity',
          config: {
            pipelineId: refs.pipelines.get(str(a.pipeline_id) ?? '') ?? undefined,
            stageId: str(a.pipeline_stage_id) ?? undefined,
            oppName: str(a.opportunity_name) ?? undefined,
            source: str(a.opportunity_source) ?? undefined,
          },
          ghl,
        }
        break
      case 'remove_opportunity': {
        // Only with a pipeline Hell-level has; it must never fall back to "any pipeline".
        const pipelineId = refs.pipelines.get(str(a.pipeline_id) ?? '')
        step = pipelineId ? { ...base, type: 'remove_opportunity', config: { pipelineId }, ghl } : { ...base, type: 'ghl', config: {}, ghl: { type: 'remove_opportunity', attributes: a } }
        if (!pipelineId) unsupported.push('remove_opportunity')
        break
      }
      case 'if_else': {
        const nodes = arr(t.next)
          .map((n) => byId.get(String(n)))
          .filter((n): n is Rec => !!n)
        const elseNode = nodes.find((n) => n.nodeType === 'branch-no' || rec(n.attributes).else === true)
        const branches: HlBranch[] = arr(a.branches)
          .map(rec)
          .map((b) => {
            const node = nodes.find((n) => String(n.id) === str(b.id))
            return {
              id: str(b.id) ?? `${id}-${Math.random().toString(36).slice(2, 7)}`,
              name: str(b.name) ?? str(node?.name) ?? 'Branch',
              operator: b.operator === 'or' ? 'or' : 'and',
              segments: arr(b.segments)
                .map(rec)
                .map((seg) => ({ operator: seg.operator === 'or' ? ('or' as const) : ('and' as const), conditions: arr(seg.conditions).map(rec).map(condition) })),
              next: node ? resolve(node.next) : null,
            }
          })
        step = { ...base, next: null, type: 'if_else', config: {}, branches, elseNext: elseNode ? resolve(elseNode.next) : null, elseName: str(elseNode?.name) ?? 'None', ghl }
        break
      }
      case 'goto':
        step = { ...base, type: 'goto', config: { target: resolve(a.targetNodeId) ?? undefined }, ghl }
        break
      case 'workflow_split': {
        const transitions = arr(a.transitions).map(rec)
        const even = transitions.length ? Math.round(100 / transitions.length) : 100
        step = {
          ...base,
          next: null,
          type: 'split',
          config: {
            paths: transitions.map((tr) => {
              const share = num(rec(tr.attributes).percentage) ?? num(tr.percentage) ?? num(rec(tr.attributes).weight) ?? even
              return { id: str(tr.id) ?? '', name: str(tr.condition) ?? str(tr.name) ?? 'Path', percent: share, next: resolve(tr.id) }
            }),
          },
          ghl,
        }
        break
      }
      case 'dnd_contact':
        step = { ...base, type: 'dnd', config: { dnd: !/disable/i.test(str(a.dnd_contact) ?? 'enable') }, ghl }
        break
      case 'update_contact_field':
        step = {
          ...base,
          type: 'update_field',
          config: {
            fields: arr(a.fields)
              .map(rec)
              .map((f) => ({
                key: refs.fieldKeys.get(str(f.field) ?? '') ?? (str(f.title) ?? str(f.field) ?? 'field').toLowerCase().replace(/[^a-z0-9]+/g, '_'),
                label: str(f.title) ?? undefined,
                value: str(f.date) === 'currentDate' ? '{{today}}' : String(f.value ?? ''),
              })),
          },
          ghl,
        }
        break
      case 'create_update_contact':
        step = {
          ...base,
          type: 'update_contact',
          config: { fields: arr(a.fields).map(rec).map((f) => ({ key: str(f.field) ?? 'field', label: str(f.title) ?? undefined, value: String(f.value ?? '') })) },
          ghl,
        }
        break
      case 'add_notes':
        step = { ...base, type: 'add_note', config: { body: plainText(String(a.html ?? a.body ?? '')) }, ghl }
        break
      case 'add_to_workflow':
        step = { ...base, type: 'add_to_workflow', config: { workflowIds: [refs.workflows.get(str(a.workflow_id) ?? '')].filter((x): x is string => !!x) }, ghl }
        break
      case 'remove_from_workflow': {
        const ids = (Array.isArray(a.workflow_id) ? a.workflow_id : [a.workflow_id]).map((x) => refs.workflows.get(str(x) ?? '')).filter((x): x is string => !!x)
        step = { ...base, type: 'remove_from_workflow', config: { workflowIds: ids, ...(a.allWorkflows === true ? { all: true } : {}) }, ghl }
        break
      }
      case 'drip':
        step = { ...base, type: 'drip', config: {}, ghl: { type: 'drip', attributes: a } }
        break
      case 'webhook':
      case 'custom_webhook': {
        const config = ghlWebhookConfig(String(t.type), a, t.stepIndex)
        if (config) step = { ...base, type: 'webhook', config, ghl }
        else {
          // OAuth2: its token lives in GHL's own connection, so nothing here can sign the request.
          unsupported.push(`${String(t.type)}:oauth2`)
          step = { ...base, type: 'ghl', config: {}, ghl: { type: String(t.type), attributes: a } }
        }
        break
      }
      default: {
        unsupported.push(String(t.type))
        // A step that forks (Find contact: found / not found) keeps its paths, so the tree under it is drawn as in GHL.
        const forks = Array.isArray(t.next)
          ? t.next
              .map((n) => byId.get(String(n)))
              .filter((x): x is Rec => !!x)
              .map((x) => ({ id: String(x.id), name: str(x.name) ?? 'Path', percent: 0, next: resolve(x.id) }))
          : []
        step = { ...base, type: 'ghl', config: forks.length ? { paths: forks } : {}, ghl: { type: String(t.type), attributes: a } }
      }
    }
    steps.push(step)
  }
  // The start goes first: Hell-level runs from the top of the list.
  const first = start ? steps.findIndex((s) => s.id === String(start.id)) : -1
  if (first > 0) steps.unshift(...steps.splice(first, 1))
  return { steps, unsupported }
}

/** GHL's triggers → Hell-level's (kept as they were under `ghl`; the ones with no equivalent never fire). */
export function convertTriggers(list: unknown, refs: Refs): HlTrigger[] {
  return arr(list)
    .map(rec)
    .filter((t) => t.deleted !== true)
    .map((t): HlTrigger => {
      const conds = arr(t.conditions).map(rec)
      const pick = (field: string) => conds.find((c) => c.field === field)
      const base = { id: str(t.id) ?? undefined, name: str(t.name) ?? undefined, active: t.active !== false, ghl: { type: String(t.type), conditions: conds } }
      switch (t.type) {
        case 'customer_reply': {
          // The reply channel: 2 = SMS, 5 = the chat widget; others (email, Facebook…) aren't Hell-level's.
          const channel = num(pick('message.type')?.value)
          if (channel === 5) {
            const widget = str(pick('message.chatWidgetId')?.value)
            const formId = widget ? refs.forms.get(widget) : undefined
            return widget && !formId ? { ...base, type: 'ghl' } : { ...base, type: 'chat_submitted', ...(formId ? { formIds: [formId] } : {}) }
          }
          if (channel !== null && channel !== 2) return { ...base, type: 'ghl' }
          // One phrase or a list ("matches any of" / "contains any of").
          const phrase = conds.find((c) => c.field === 'message.body')
          const phrases = (Array.isArray(phrase?.value) ? phrase.value : [phrase?.value]).map(str).filter((x): x is string => !!x)
          const match = phrase && /exact|matches/i.test(`${phrase.operator} ${phrase.id}`) ? 'exact' : 'contains'
          return { ...base, type: 'inbound_sms', match, ...(phrases.length ? { keywords: phrases } : {}) }
        }
        case 'call_status': {
          // GHL's missed-call trigger: an inbound call that's busy, no-answer or voicemail.
          const statuses = arr(pick('call_status')?.value).map((v) => str(v)?.toLowerCase())
          const inbound = str(pick('message.direction')?.value)
          return (!inbound || inbound === 'inbound') && (!statuses.length || statuses.some((s) => s === 'busy' || s === 'no-answer' || s === 'voicemail')) ? { ...base, type: 'missed_call' } : { ...base, type: 'ghl' }
        }
        case 'trigger_link':
          // A client sub-account has one trigger link, the review link.
          return { ...base, type: 'link_clicked', link: 'review' }
        case 'survey_submission': {
          const survey = refs.forms.get(str(arr(pick('survey.id')?.value)[0] ?? pick('survey.id')?.value) ?? '')
          return survey ? { ...base, type: 'form_submitted', formIds: [survey] } : { ...base, type: 'ghl' }
        }
        case 'contact_tag': {
          const added = pick('tagsAdded')
          return added ? { ...base, type: 'tag_added', tag: str(added.value)?.toLowerCase() } : { ...base, type: 'ghl' }
        }
        case 'form_submission': {
          const forms = (arr(pick('form.id')?.value).length ? arr(pick('form.id')?.value) : [pick('form.id')?.value]).map(str).filter((x): x is string => !!x)
          const mapped = forms.map((f) => refs.forms.get(f)).filter((x): x is string => !!x)
          // Forms Hell-level doesn't have: a trigger with no forms left would fire on every form.
          return forms.length && !mapped.length ? { ...base, type: 'ghl' } : { ...base, type: 'form_submitted', ...(mapped.length ? { formIds: mapped } : {}) }
        }
        case 'pipeline_stage_updated':
        case 'opportunity_changed':
          return { ...base, type: 'opportunity_stage', pipelineId: refs.pipelines.get(str(pick('opportunity.pipelineId')?.value) ?? '') ?? undefined, stageId: str(pick('opportunity.pipelineStageId')?.value) ?? undefined }
        case 'opportunity_created':
          return { ...base, type: 'opportunity_created', pipelineId: refs.pipelines.get(str(pick('opportunity.pipelineId')?.value) ?? '') ?? undefined, stageId: str(pick('opportunity.pipelineStageId')?.value) ?? undefined }
        case 'customer_appointment':
        case 'appointment': {
          // A calendar Hell-level doesn't have: unfiltered, the trigger would fire for every calendar.
          const ghlCalendar = str(arr(pick('calendar.id')?.value)[0] ?? pick('calendar.id')?.value)
          const calendarId = ghlCalendar ? refs.calendars.get(ghlCalendar) : undefined
          if (ghlCalendar && !calendarId) return { ...base, type: 'ghl' }
          if (t.type === 'customer_appointment') return { ...base, type: 'appointment_booked', ...(calendarId ? { calendarId } : {}) }
          const status = str(pick('appointment.status')?.value ?? pick('appointment.appointmentStatus')?.value)
          return { ...base, type: 'appointment_status', status: status ?? undefined, ...(calendarId ? { calendarId } : {}) }
        }
        case 'validation_error':
          return { ...base, type: 'sms_error' }
        case 'inbound_webhook':
          // Its URL is Hell-level's own, given (or kept) when the workflow is saved.
          return { ...base, type: 'inbound_webhook' }
        default:
          return { ...base, type: 'ghl' }
      }
    })
}

/** Bring a sub-account's GHL workflows over (or bring them up to date): folders, triggers, steps, on/off. */
export async function importGhlWorkflows(accountId: string, x: GhlExport): Promise<GhlWorkflowImport> {
  const paths = folderPaths(x.tree)
  const [pipelines, calendars, forms, fields] = await Promise.all([
    prisma.hlPipeline.findMany({ where: { accountId, ghlId: { not: null } }, select: { id: true, ghlId: true } }),
    prisma.hlCalendar.findMany({ where: { accountId, ghlId: { not: null } }, select: { id: true, ghlId: true } }),
    prisma.hlForm.findMany({ where: { accountId, ghlId: { not: null } }, select: { id: true, ghlId: true } }),
    prisma.hlRecord.findMany({ where: { accountId, kind: 'custom_field', ghlId: { not: null } }, select: { ghlId: true, data: true } }),
  ])
  const fieldKeys = new Map<string, string>()
  for (const f of fields) {
    const key = str(rec(f.data).fieldKey)
    if (f.ghlId && key) fieldKeys.set(f.ghlId, key.replace(/^contact\./, ''))
  }

  // The folders, empty ones too.
  const folderList = [...new Set(paths.values())].filter(Boolean)
  for (const name of folderList) {
    const exists = await prisma.hlRecord.findFirst({ where: { accountId, kind: 'workflow_folder', name } })
    if (!exists) await prisma.hlRecord.create({ data: { accountId, kind: 'workflow_folder', name } })
  }

  // Every workflow gets its row first, so steps that point at another workflow can find it.
  const items = x.tree.filter((t) => t.type !== 'directory' && x.workflows[t.id])
  const ids = new Map<string, string>()
  for (const t of items) {
    const def = rec(x.workflows[t.id].def)
    const name = (str(def.name) ?? t.name).slice(0, 200)
    const folder = (t.parentId && paths.get(t.parentId)) || null
    const row = await prisma.hlWorkflow.upsert({
      where: { accountId_ghlId: { accountId, ghlId: t.id } },
      create: { accountId, ghlId: t.id, name, folder, status: 'draft', trigger: { type: 'manual' }, steps: [] },
      update: { name, folder },
      select: { id: true },
    })
    ids.set(t.id, row.id)
  }
  const refs: Refs = {
    pipelines: new Map(pipelines.map((p) => [p.ghlId!, p.id])),
    calendars: new Map(calendars.map((c) => [c.ghlId!, c.id])),
    forms: new Map(forms.map((f) => [f.ghlId!, f.id])),
    workflows: ids,
    fieldKeys,
  }

  const result: GhlWorkflowImport = { folders: folderList.length, workflows: 0, published: 0, steps: 0, unsupported: {}, idleTriggers: {} }
  for (const t of items) {
    const def = rec(x.workflows[t.id].def)
    const { steps, unsupported } = convertSteps(arr(rec(def.workflowData).templates).map(rec), refs)
    const existing = await prisma.hlWorkflow.findUnique({ where: { id: ids.get(t.id)! }, select: { meta: true, publishedAt: true, triggers: true } })
    // A webhook trigger keeps its URL, field picks and reference through a re-import, so whatever posts to it keeps working.
    const before = new Map((Array.isArray(existing?.triggers) ? (existing.triggers as HlTrigger[]) : []).filter((tr) => tr.hookId).map((tr) => [tr.id, tr]))
    const ghlReference = rec(def.inboundWebhookReference).payload
    const triggers = await ensureHookIds(
      ids.get(t.id)!,
      convertTriggers(x.workflows[t.id].trig, refs).map((tr) => {
        if (tr.type !== 'inbound_webhook') return tr
        const kept = before.get(tr.id)
        const reference = kept?.reference ?? (ghlReference !== undefined && (JSON.stringify(ghlReference)?.length ?? Infinity) <= 50_000 ? { at: new Date().toISOString(), payload: ghlReference } : undefined)
        return { ...tr, ...(kept?.hookId ? { hookId: kept.hookId } : {}), ...(kept?.mapping ? { mapping: kept.mapping } : {}), ...(reference ? { reference } : {}) }
      }),
    )
    for (const u of unsupported) result.unsupported[u] = (result.unsupported[u] ?? 0) + 1
    for (const tr of triggers) if (tr.type === 'ghl') result.idleTriggers[tr.ghl?.type ?? 'unknown'] = (result.idleTriggers[tr.ghl?.type ?? 'unknown'] ?? 0) + 1
    const published = (str(def.status) ?? t.status) === 'published'
    await prisma.hlWorkflow.update({
      where: { id: ids.get(t.id)! },
      data: {
        status: published ? 'published' : 'draft',
        publishedAt: published ? (existing?.publishedAt ?? new Date()) : null,
        trigger: json(triggers[0] ?? { type: 'manual' }),
        triggers: json(triggers),
        steps: json(steps),
        allowReentry: def.allowMultiple !== false,
        meta: json({
          ...rec(existing?.meta),
          ghlStatus: str(def.status),
          ghlVersion: num(def.version),
          ghlUpdatedAt: str(def.updatedAt),
          stopOnResponse: def.stopOnResponse === true,
          imported: { at: new Date().toISOString(), steps: steps.length, unsupported },
        }),
      },
    })
    result.workflows++
    if (published) result.published++
    result.steps += steps.length
  }

  // The old catch-all folder from the names-only import, once it's empty.
  const leftover = await prisma.hlWorkflow.count({ where: { accountId, folder: 'Imported from GoHighLevel' } })
  if (!leftover) await prisma.hlRecord.deleteMany({ where: { accountId, kind: 'workflow_folder', name: 'Imported from GoHighLevel' } })
  return result
}
