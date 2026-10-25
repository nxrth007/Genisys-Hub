import { randomBytes } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { asTriggers, fireTrigger } from './automation'
import { upsertContact } from './contacts'
import { toE164 } from './phone'
import { HOOK_ID_PATTERN, type HlTrigger } from './types'
import { contactFromPayload } from './webhook-shared'

/**
 * Inbound webhooks, GHL's "Inbound webhook" trigger. Each trigger has its
 * own URL, /api/hl/public/hooks/<hookId>, that another app (Zapier, a
 * website's own form, a CRM) posts JSON or form data to.
 *
 * Every request is kept (the latest 20 per URL) so the builder can show it
 * and offer its fields as {{inboundWebhookRequest.*}} (GHL's "mapping
 * reference"). While the workflow is a draft that's all that happens. Once
 * it's published, the request's email or phone finds the contact, or makes
 * one, and the workflow starts for them with the request saved on the run.
 * Texting consent is only ever recorded from a field the trigger maps to it.
 */

/** GHL's limit. */
export const MAX_BODY = 1_000_000
/** What's kept of a request, on its record and on the run. */
const MAX_KEPT = 64_000
const KEEP = 20
const KIND = 'webhook_request'
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const newHookId = () => randomBytes(24).toString('base64url')

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})

/** The workflows a URL belongs to (one, as URLs are kept unique). Deleted ones too: a restore brings the URL back. */
function workflowsForHook(hookId: string) {
  return prisma.hlWorkflow.findMany({
    where: { OR: [{ triggers: { array_contains: [{ hookId }] } }, { trigger: { path: ['hookId'], equals: hookId } }] },
    select: { id: true, accountId: true, name: true, status: true, deletedAt: true, trigger: true, triggers: true, account: { select: { archivedAt: true } } },
  })
}

/**
 * Every webhook trigger with a URL of its own: a missing, malformed or
 * borrowed one (another workflow's) gets a new one. Called whenever a
 * workflow's triggers are saved.
 */
export async function ensureHookIds(workflowId: string | null, triggers: HlTrigger[]): Promise<HlTrigger[]> {
  const out: HlTrigger[] = []
  const seen = new Set<string>()
  for (const t of triggers) {
    if (t.type !== 'inbound_webhook') {
      out.push(t)
      continue
    }
    let hookId = t.hookId && HOOK_ID_PATTERN.test(t.hookId) && !seen.has(t.hookId) ? t.hookId : null
    if (hookId && (await workflowsForHook(hookId)).some((w) => w.id !== workflowId)) hookId = null
    hookId ??= newHookId()
    seen.add(hookId)
    out.push({ ...t, hookId })
  }
  return out
}

/** URLs a save dropped: their test requests go with them, as in GHL. */
export async function forgetHooks(accountId: string, before: HlTrigger[], after: HlTrigger[]): Promise<void> {
  const kept = new Set(after.map((t) => t.hookId).filter(Boolean))
  const gone = before.map((t) => t.hookId).filter((h): h is string => !!h && !kept.has(h))
  if (gone.length) await prisma.hlRecord.deleteMany({ where: { accountId, kind: KIND, name: { in: gone } } })
}

// ---------------------------------------------------------------------------
// Reading a request
// ---------------------------------------------------------------------------

/** Form fields as an object; a name sent twice becomes a list. */
function formObject(entries: Iterable<[string, FormDataEntryValue | string]>): Rec {
  const out: Rec = {}
  for (const [k, raw] of entries) {
    const v = typeof raw === 'string' ? raw : `(file: ${raw.name})`
    const had = out[k]
    out[k] = had === undefined ? v : Array.isArray(had) ? [...had, v] : [had, v]
  }
  return out
}

export type ReadPayload = { ok: true; payload: unknown; contentType: string; bytes: number } | { ok: false; status: number; error: string }

/** The request's data: JSON, form data or plain text, with the URL's query fields alongside. */
export async function readPayload(req: Request): Promise<ReadPayload> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return { ok: false, status: 413, error: 'Requests can be up to 1 MB.' }
  const buf = await req.arrayBuffer()
  if (buf.byteLength > MAX_BODY) return { ok: false, status: 413, error: 'Requests can be up to 1 MB.' }
  const contentType = (req.headers.get('content-type') ?? '').toLowerCase()
  const text = new TextDecoder().decode(buf)
  const query = formObject(new URL(req.url).searchParams.entries())
  let body: unknown = {}
  if (text.trim()) {
    if (contentType.includes('json') || /^\s*[[{]/.test(text)) {
      try {
        body = JSON.parse(text)
      } catch {
        return { ok: false, status: 400, error: 'The request’s JSON couldn’t be read.' }
      }
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      body = formObject(new URLSearchParams(text).entries())
    } else if (contentType.includes('multipart/form-data')) {
      try {
        body = formObject((await new Response(buf, { headers: { 'content-type': contentType } }).formData()).entries())
      } catch {
        return { ok: false, status: 400, error: 'The request’s form data couldn’t be read.' }
      }
    } else {
      body = { body: text }
    }
  }
  const payload = body && typeof body === 'object' && !Array.isArray(body) ? { ...query, ...(body as Rec) } : Array.isArray(body) ? body : query
  return { ok: true, payload, contentType: contentType.split(';')[0].trim(), bytes: buf.byteLength }
}

/** A request as kept: whole up to 64 KB, else its top-level plain values. */
function kept(payload: unknown): unknown {
  const text = JSON.stringify(payload) ?? 'null'
  if (text.length <= MAX_KEPT) return payload
  const top = Object.entries(rec(payload)).filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
  return { ...Object.fromEntries(top.map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 2000) : v])), _truncated: `${Math.round(text.length / 1000)} KB request: only its top-level fields were kept` }
}

// ---------------------------------------------------------------------------
// Receiving one
// ---------------------------------------------------------------------------

export type Received = {
  status: number
  body: Rec
  /** Work to do after answering (the run), so the sender isn't kept waiting. */
  later?: () => Promise<void>
}

async function note(id: string, outcome: Rec): Promise<void> {
  const row = await prisma.hlRecord.findUnique({ where: { id }, select: { data: true } })
  if (row) await prisma.hlRecord.update({ where: { id }, data: { data: { ...rec(row.data), outcome } as Prisma.InputJsonValue } })
}

/** A request to a webhook URL: kept, then (published workflows) the contact found and the workflow started. */
export async function receiveWebhook(hookId: string, payload: unknown, meta: { ip: string | null; contentType: string; bytes: number }): Promise<Received> {
  if (!HOOK_ID_PATTERN.test(hookId)) return { status: 404, body: { error: 'This webhook URL isn’t in use.' } }
  const workflows = await workflowsForHook(hookId)
  if (!workflows.length) return { status: 404, body: { error: 'This webhook URL isn’t in use.' } }
  const live = workflows.filter((w) => !w.deletedAt && !w.account.archivedAt)
  if (!live.length) return { status: 410, body: { error: 'The workflow behind this URL was deleted.' } }
  const accountId = live[0].accountId

  const payloadKept = kept(payload)
  const row = await prisma.hlRecord.create({
    data: { accountId, kind: KIND, name: hookId, data: { at: new Date().toISOString(), ip: meta.ip, contentType: meta.contentType, bytes: meta.bytes, payload: payloadKept, outcome: { status: 'received' } } as Prisma.InputJsonValue },
    select: { id: true },
  })
  const old = await prisma.hlRecord.findMany({ where: { accountId, kind: KIND, name: hookId }, orderBy: { createdAt: 'desc' }, skip: KEEP, select: { id: true } })
  if (old.length) await prisma.hlRecord.deleteMany({ where: { id: { in: old.map((o) => o.id) } } })

  const trigger = live
    .filter((w) => w.status === 'published')
    .flatMap((w) => asTriggers(w))
    .find((t) => t.type === 'inbound_webhook' && t.hookId === hookId && t.active !== false)
  if (!trigger) {
    const why = live.some((w) => w.status === 'published') ? 'the trigger is switched off' : 'the workflow is a draft'
    await note(row.id, { status: 'test', detail: `Kept as a test request: ${why}` })
    return { status: 200, body: { ok: true, id: row.id, started: false, note: `Saved as a test request; ${why}, so nothing ran.` } }
  }

  return {
    status: 200,
    body: { ok: true, id: row.id },
    later: async () => {
      const who = contactFromPayload(payload, trigger.mapping)
      // Only a usable email or phone finds (or makes) a contact; a request with neither starts nothing.
      const email = who.email && EMAIL.test(who.email.trim()) ? who.email : undefined
      const phone = toE164(who.phone) ? who.phone : undefined
      if (!email && !phone) {
        await note(row.id, { status: 'skipped', detail: who.email || who.phone ? 'The request’s email or phone wasn’t valid, so the workflow didn’t start' : 'No email or phone in the request to find the contact by, so the workflow didn’t start' })
        return
      }
      const { contact, created } = await upsertContact(accountId, {
        email,
        phone,
        firstName: who.firstName,
        lastName: who.lastName,
        fullName: who.fullName,
        source: 'webhook',
        consent: who.consent,
        marketingConsent: who.marketingConsent,
      })
      const context = { webhook: payloadKept }
      if (created) await fireTrigger(accountId, contact.id, { type: 'contact_created', context })
      const started = await fireTrigger(accountId, contact.id, { type: 'inbound_webhook', hookId, context })
      await note(row.id, {
        status: started ? 'started' : 'not_started',
        contactId: contact.id,
        created,
        detail: started
          ? `Started for ${created ? 'a new contact' : 'an existing contact'}`
          : 'Didn’t start: this contact went through the workflow under a minute ago, or re-entry is off',
      })
    },
  }
}

/** The URL's latest requests, newest first (the builder's list). */
export async function hookRequests(accountId: string, hookId: string) {
  const rows = await prisma.hlRecord.findMany({ where: { accountId, kind: KIND, name: hookId }, orderBy: { createdAt: 'desc' }, take: KEEP, select: { id: true, data: true, createdAt: true } })
  return rows.map((r) => {
    const d = rec(r.data)
    return { id: r.id, at: typeof d.at === 'string' ? d.at : r.createdAt.toISOString(), contentType: d.contentType ?? null, bytes: d.bytes ?? null, payload: d.payload ?? null, outcome: rec(d.outcome) }
  })
}

// ---------------------------------------------------------------------------
// GHL's webhook triggers, imported before Hell-level had them
// ---------------------------------------------------------------------------

let upgraded = false

/**
 * Once, on the first scheduler tick after this deploy: triggers imported
 * from GHL as "GoHighLevel inbound_webhook" (kept, never fired) become real
 * webhook triggers with URLs of their own. Nothing posts to those URLs until
 * the sending app is pointed at them, so this starts nothing by itself.
 */
export async function maybeUpgradeWebhookTriggers(): Promise<number> {
  if (upgraded) return 0
  const key = 'hl.webhookTriggers.v1'
  if (await prisma.appSetting.findUnique({ where: { key }, select: { id: true } })) {
    upgraded = true
    return 0
  }
  try {
    await prisma.appSetting.create({ data: { key, value: 'running' } })
  } catch {
    return 0 // another container got there first
  }
  upgraded = true
  const rows = await prisma.hlWorkflow.findMany({
    where: { triggers: { array_contains: [{ type: 'ghl', ghl: { type: 'inbound_webhook' } }] } },
    select: { id: true, triggers: true },
  })
  for (const w of rows) {
    const list = (Array.isArray(w.triggers) ? w.triggers : []) as HlTrigger[]
    const next = await ensureHookIds(
      w.id,
      list.map((t) => (t.type === 'ghl' && t.ghl?.type === 'inbound_webhook' ? { ...t, type: 'inbound_webhook' as const } : t)),
    )
    await prisma.hlWorkflow.update({ where: { id: w.id }, data: { triggers: next as unknown as Prisma.InputJsonValue, trigger: (next[0] ?? { type: 'manual' }) as unknown as Prisma.InputJsonValue } })
  }
  await prisma.appSetting.update({ where: { key }, data: { value: `done ${new Date().toISOString()}: ${rows.length} workflow(s)` } })
  return rows.length
}
