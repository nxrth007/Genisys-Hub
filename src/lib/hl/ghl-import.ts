import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { API_VERSION, BASE_URL, resolveGhlToken } from '@/lib/ghl'
import { readProfile } from './accounts'
import { HlInputError } from './http'
import { splitName, toE164 } from './phone'
import type { HlProfile, HlStage } from './types'

/**
 * Copies a GoHighLevel sub-account into Hell-level: business profile, staff,
 * tags, custom fields and values, pipelines, contacts, opportunities,
 * conversations with their messages, notes, tasks, calendars and
 * appointments, workflows, forms with submissions, and the lists GHL keeps
 * (funnels, websites, media, products, invoices, orders, transactions,
 * subscriptions, coupons, trigger links, snippets, companies, surveys).
 *
 * Read-only on the GHL side. Every record keeps its GHL id, so running it
 * again updates what's there instead of duplicating it. It runs in the
 * background, saving its place after every page (AppSetting
 * hl.import.<accountId>), and the scheduler picks a stalled import back up
 * after a deploy. A section the GHL key isn't allowed to read is skipped
 * with the reason; the rest carries on.
 *
 * GHL's API has no export for workflow steps, funnel/website pages,
 * courses or reviews: those come over as names and lists only.
 */

export const DEFAULT_GHL_VAULT = 'GHL Genisys Token'
const STATE_PREFIX = 'hl.import.'
export const DEFAULT_ACCOUNT_KEY = 'hl.defaultAccount'

export const IMPORT_PHASES = [
  ['location', 'Business profile'],
  ['users', 'Staff'],
  ['tags', 'Tags'],
  ['customFields', 'Custom fields'],
  ['customValues', 'Custom values'],
  ['pipelines', 'Pipelines'],
  ['contacts', 'Contacts'],
  ['opportunities', 'Opportunities'],
  ['conversations', 'Conversations & messages'],
  ['notesTasks', 'Notes & tasks'],
  ['calendars', 'Calendars & appointments'],
  ['workflows', 'Workflows (names)'],
  ['forms', 'Forms & submissions'],
  ['surveys', 'Surveys'],
  ['funnels', 'Funnels & websites (names)'],
  ['media', 'Media storage'],
  ['payments', 'Payments'],
  ['links', 'Trigger links'],
  ['snippets', 'Snippets'],
  ['companies', 'Companies'],
  ['finish', 'Wrap-up'],
] as const
export type ImportPhase = (typeof IMPORT_PHASES)[number][0]

export type PhaseState = { status: 'pending' | 'running' | 'done' | 'skipped' | 'failed'; count: number; detail?: string; cursor?: Record<string, unknown> }

export type ImportState = {
  accountId: string
  vaultName: string
  locationId: string
  status: 'running' | 'done' | 'failed'
  phase: ImportPhase | null
  phases: Record<ImportPhase, PhaseState>
  startedAt: string
  startedBy: string
  heartbeat: string
  finishedAt?: string
  error?: string
}

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v)
const rec = (v: unknown): Rec => (isRec(v) ? v : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
const when = (v: unknown): Date | null => {
  if (v === null || v === undefined || v === '') return null
  const d = typeof v === 'number' || /^\d{10,13}$/.test(String(v)) ? new Date(Number(v) < 1e12 ? Number(v) * 1000 : Number(v)) : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}
/** The first array in a response, under any of these keys (GHL nests lists differently per endpoint). */
function listIn(v: unknown, keys: string[]): Rec[] {
  if (Array.isArray(v)) return v.filter(isRec)
  const o = rec(v)
  for (const k of keys) {
    const x = o[k]
    if (Array.isArray(x)) return x.filter(isRec)
    if (isRec(x)) {
      const inner = listIn(x, keys)
      if (inner.length) return inner
    }
  }
  return []
}
const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? {})) as Prisma.InputJsonValue
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// GHL calls: paced under GHL's limit (100 per 10 s per location), retried on
// 429/5xx with backoff.
// ---------------------------------------------------------------------------

export class GhlError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'GhlError'
  }
}

let nextSlot = 0
async function pace() {
  const now = Date.now()
  const wait = Math.max(0, nextSlot - now)
  nextSlot = Math.max(now, nextSlot) + 130
  if (wait) await sleep(wait)
}

type Ctx = {
  accountId: string
  locationId: string
  token: string
  state: ImportState
  users: Map<string, string>
  contactIds: Map<string, string>
  fieldKeys: Map<string, string>
  save: (force?: boolean) => Promise<void>
}

async function ghl(c: Ctx, path: string, init: { method?: string; body?: unknown; version?: string } = {}): Promise<Rec> {
  for (let attempt = 0; ; attempt++) {
    await pace()
    let res: Response
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${c.token}`,
          Version: init.version ?? API_VERSION,
          Accept: 'application/json',
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(45_000),
      })
    } catch (err) {
      if (attempt < 3) {
        await sleep(1500 * 2 ** attempt)
        continue
      }
      throw err
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const retryAfter = Number(res.headers.get('retry-after'))
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt)
      continue
    }
    const text = await res.text()
    if (!res.ok) throw new GhlError(res.status, `GHL ${res.status}: ${text.slice(0, 240)}`)
    try {
      return text ? rec(JSON.parse(text)) : {}
    } catch {
      return {}
    }
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export async function readImportState(accountId: string): Promise<ImportState | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: `${STATE_PREFIX}${accountId}` } })
  if (!row) return null
  try {
    return JSON.parse(row.value) as ImportState
  } catch {
    return null
  }
}

async function writeImportState(s: ImportState): Promise<void> {
  const key = `${STATE_PREFIX}${s.accountId}`
  const value = JSON.stringify(s)
  await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

export async function defaultAccountId(): Promise<string | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: DEFAULT_ACCOUNT_KEY } })
  const id = row?.value?.trim()
  if (!id) return null
  const exists = await prisma.hlAccount.findFirst({ where: { id, archivedAt: null }, select: { id: true } })
  return exists?.id ?? null
}

export async function setDefaultAccount(accountId: string): Promise<void> {
  await prisma.appSetting.upsert({ where: { key: DEFAULT_ACCOUNT_KEY }, create: { key: DEFAULT_ACCOUNT_KEY, value: accountId }, update: { value: accountId } })
}

function freshPhases(): Record<ImportPhase, PhaseState> {
  return Object.fromEntries(IMPORT_PHASES.map(([k]) => [k, { status: 'pending', count: 0 }])) as Record<ImportPhase, PhaseState>
}

/**
 * Start (or restart) importing the GHL location behind a Vault key. Makes the
 * Hell-level sub-account for that location the first time, and makes it the
 * one Hell-level opens on when no other default is set.
 */
export async function startGhlImport(o: { vaultName?: string; accountId?: string; by: string }): Promise<ImportState> {
  const vaultName = o.vaultName?.trim() || DEFAULT_GHL_VAULT
  let resolved: { token: string; locationId: string }
  try {
    resolved = await resolveGhlToken(vaultName)
  } catch (err) {
    throw new HlInputError(`Can’t use the Vault key “${vaultName}”: ${err instanceof Error ? err.message : String(err)}`)
  }
  let account = o.accountId
    ? await prisma.hlAccount.findUnique({ where: { id: o.accountId } })
    : await prisma.hlAccount.findUnique({ where: { ghlLocationId: resolved.locationId } })
  if (!account) {
    account = await prisma.hlAccount.create({ data: { name: 'Lead Genisys', ghlLocationId: resolved.locationId, profile: {} } })
  } else if (account.ghlLocationId !== resolved.locationId) {
    const taken = await prisma.hlAccount.findUnique({ where: { ghlLocationId: resolved.locationId } })
    if (taken && taken.id !== account.id) throw new HlInputError(`That GHL location is already imported into “${taken.name}”.`)
    account = await prisma.hlAccount.update({ where: { id: account.id }, data: { ghlLocationId: resolved.locationId } })
  }
  const existing = await readImportState(account.id)
  if (existing?.status === 'running' && Date.now() - Date.parse(existing.heartbeat) < 3 * 60_000) return existing
  const now = new Date().toISOString()
  const state: ImportState = {
    accountId: account.id,
    vaultName,
    locationId: resolved.locationId,
    status: 'running',
    phase: null,
    phases: freshPhases(),
    startedAt: now,
    startedBy: o.by,
    heartbeat: now,
  }
  await writeImportState(state)
  if (!(await defaultAccountId())) await setDefaultAccount(account.id)
  void runGhlImport(account.id)
  return state
}

const running = new Set<string>()

/** Work through the phases still to do. Safe to call again: a running import in this process is left alone. */
export async function runGhlImport(accountId: string): Promise<void> {
  if (running.has(accountId)) return
  running.add(accountId)
  const state = await readImportState(accountId)
  try {
    if (!state || state.status !== 'running') return
    const { token, locationId } = await resolveGhlToken(state.vaultName)
    if (locationId !== state.locationId) throw new Error('The Vault key now points at a different GHL location.')
    let lastSave = 0
    const s = state
    const c: Ctx = {
      accountId,
      locationId,
      token,
      state: s,
      users: new Map(),
      contactIds: new Map(),
      fieldKeys: new Map(),
      save: async (force = false) => {
        s.heartbeat = new Date().toISOString()
        if (!force && Date.now() - lastSave < 2000) return
        lastSave = Date.now()
        await writeImportState(s)
      },
    }
    await loadMaps(c)
    for (const [key] of IMPORT_PHASES) {
      const ph = s.phases[key]
      if (ph.status === 'done' || ph.status === 'skipped' || ph.status === 'failed') continue
      ph.status = 'running'
      s.phase = key
      await c.save(true)
      try {
        await PHASES[key](c, ph)
        ph.status = 'done'
        delete ph.cursor
      } catch (err) {
        if (err instanceof GhlError && (err.status === 401 || err.status === 403)) {
          ph.status = 'skipped'
          ph.detail = 'The GHL key isn’t allowed to read this. Add the scope to the Private Integration in GHL, then run the import again.'
        } else if (err instanceof GhlError && (err.status === 404 || err.status === 400 || err.status === 422)) {
          ph.status = 'skipped'
          ph.detail = `GHL didn’t return this (${err.message.slice(0, 160)})`
        } else {
          ph.status = 'failed'
          ph.detail = err instanceof Error ? err.message.slice(0, 300) : String(err)
        }
        console.warn(`[hell-level import] ${key}: ${ph.status}: ${ph.detail}`)
      }
      await c.save(true)
    }
    s.status = 'done'
    s.phase = null
    s.finishedAt = new Date().toISOString()
    await writeImportState(s)
    console.log(`[hell-level import] ${accountId} done`)
  } catch (err) {
    if (state) {
      state.status = 'failed'
      state.error = err instanceof Error ? err.message : String(err)
      state.finishedAt = new Date().toISOString()
      await writeImportState(state).catch(() => {})
    }
    console.error('[hell-level import] failed:', err)
  } finally {
    running.delete(accountId)
  }
}

/** Every minute from the scheduler: an import whose process died (a deploy) carries on. */
export async function maybeResumeImports(): Promise<number> {
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: STATE_PREFIX } } })
  let resumed = 0
  for (const row of rows) {
    try {
      const s = JSON.parse(row.value) as ImportState
      if (s.status !== 'running' || running.has(s.accountId)) continue
      if (Date.now() - Date.parse(s.heartbeat) < 2 * 60_000) continue
      resumed++
      void runGhlImport(s.accountId)
    } catch {
      // unreadable state: leave it
    }
  }
  return resumed
}

/** Staff names and contact ids already imported (a resumed import needs them). */
async function loadMaps(c: Ctx) {
  const [users, fields] = await Promise.all([
    prisma.hlRecord.findMany({ where: { accountId: c.accountId, kind: 'user' }, select: { ghlId: true, name: true } }),
    prisma.hlRecord.findMany({ where: { accountId: c.accountId, kind: 'custom_field' }, select: { ghlId: true, data: true } }),
  ])
  for (const u of users) if (u.ghlId) c.users.set(u.ghlId, u.name)
  for (const f of fields) {
    const key = str(rec(f.data).fieldKey)
    if (f.ghlId && key) c.fieldKeys.set(f.ghlId, key.replace(/^contact\./, ''))
  }
}

async function contactIdFor(c: Ctx, ghlContactId: string | null, fallback?: Rec): Promise<string | null> {
  if (!ghlContactId) return null
  const hit = c.contactIds.get(ghlContactId)
  if (hit) return hit
  const row = await prisma.hlContact.findUnique({ where: { accountId_ghlId: { accountId: c.accountId, ghlId: ghlContactId } }, select: { id: true } })
  if (row) {
    c.contactIds.set(ghlContactId, row.id)
    return row.id
  }
  if (!fallback) return null
  // A record pointing at a contact the contact list didn't have (deleted in GHL, or created since): keep what we know.
  const name = splitName(str(fallback.fullName) ?? str(fallback.contactName) ?? str(fallback.name))
  const created = await prisma.hlContact.create({
    data: {
      accountId: c.accountId,
      ghlId: ghlContactId,
      firstName: name.firstName,
      lastName: name.lastName,
      phone: toE164(str(fallback.phone)),
      email: str(fallback.email)?.toLowerCase() ?? null,
      source: 'ghl',
    },
    select: { id: true },
  })
  c.contactIds.set(ghlContactId, created.id)
  return created.id
}

async function upsertRecord(c: Ctx, kind: string, ghlId: string | null, name: string, data: Rec) {
  if (!ghlId) return
  await prisma.hlRecord.upsert({
    where: { accountId_kind_ghlId: { accountId: c.accountId, kind, ghlId } },
    create: { accountId: c.accountId, kind, ghlId, name: name.slice(0, 300) || kind, data: json(data) },
    update: { name: name.slice(0, 300) || kind, data: json(data) },
  })
}

/** A simple list endpoint into HlRecord rows; paging by offset when GHL pages it. */
async function importList(
  c: Ctx,
  ph: PhaseState,
  o: { kind: string | ((r: Rec) => string); path: (offset: number) => string; keys: string[]; name: (r: Rec) => string | null; pageSize?: number; maxPages?: number },
): Promise<number> {
  let offset = num(ph.cursor?.[`offset`]) ?? 0
  let count = 0
  for (let page = 0; page < (o.maxPages ?? 200); page++) {
    const r = await ghl(c, o.path(offset))
    const list = listIn(r, o.keys)
    for (const item of list) {
      const id = str(item.id) ?? str(item._id)
      const kind = typeof o.kind === 'function' ? o.kind(item) : o.kind
      await upsertRecord(c, kind, id, o.name(item) ?? id ?? kind, item)
      count++
    }
    ph.count += list.length
    if (!o.pageSize || list.length < o.pageSize) break
    offset += list.length
    ph.cursor = { offset }
    await c.save()
  }
  return count
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

const MESSAGE_CAP = 300

function channelOf(m: Rec): string {
  const t = String(m.messageType ?? '').toUpperCase()
  const n = num(m.type)
  if (t === 'TYPE_SMS' || t === 'TYPE_MMS' || n === 2) return 'sms'
  if (t === 'TYPE_CALL' || n === 1) return 'call'
  if (t === 'TYPE_EMAIL' || n === 3) return 'email'
  if (t.startsWith('TYPE_ACTIVITY') || t.includes('CAMPAIGN') || t === 'TYPE_NO_SHOW' || t === 'TYPE_CUSTOM_PROVIDER_EMAIL') return 'activity'
  return t ? 'chat' : 'sms'
}

const PHASES: Record<ImportPhase, (c: Ctx, ph: PhaseState) => Promise<void>> = {
  async location(c, ph) {
    const r = await ghl(c, `/locations/${c.locationId}`)
    const loc = rec(r.location ?? r)
    const business = rec(loc.business)
    const account = await prisma.hlAccount.findUniqueOrThrow({ where: { id: c.accountId } })
    const p = readProfile(account.profile)
    const name = str(loc.name) ?? account.name
    const address = [str(loc.address), str(loc.city), [str(loc.state), str(loc.postalCode)].filter(Boolean).join(' ')].filter(Boolean).join(', ')
    const next: HlProfile = {
      ...p,
      businessName: p.businessName || str(business.name) || name,
      businessPhone: p.businessPhone || str(loc.phone) || '',
      website: p.website || str(loc.website) || str(business.website) || '',
      address: p.address || address,
      notifyEmail: p.notifyEmail || str(loc.email) || '',
      legalName: p.legalName || str(business.name) || name,
    }
    const tz = str(loc.timezone)
    let timezone = account.timezone
    if (tz) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz })
        timezone = tz
      } catch {
        // keep ours
      }
    }
    await prisma.hlAccount.update({ where: { id: c.accountId }, data: { name, timezone, profile: next as Prisma.InputJsonValue } })
    await upsertRecord(c, 'location', c.locationId, name, loc)
    ph.count = 1
  },

  async users(c, ph) {
    const r = await ghl(c, `/users/?locationId=${c.locationId}`)
    for (const u of listIn(r, ['users'])) {
      const id = str(u.id)
      const name = str(u.name) ?? ([str(u.firstName), str(u.lastName)].filter(Boolean).join(' ') || str(u.email) || 'User')
      if (id) c.users.set(id, name)
      await upsertRecord(c, 'user', id, name, { email: u.email, phone: u.phone, roles: u.roles, firstName: u.firstName, lastName: u.lastName })
      ph.count++
    }
  },

  async tags(c, ph) {
    const r = await ghl(c, `/locations/${c.locationId}/tags`)
    for (const t of listIn(r, ['tags'])) {
      await upsertRecord(c, 'tag', str(t.id) ?? str(t.name), str(t.name) ?? 'tag', t)
      ph.count++
    }
  },

  async customFields(c, ph) {
    const r = await ghl(c, `/locations/${c.locationId}/customFields`)
    for (const f of listIn(r, ['customFields', 'fields'])) {
      const id = str(f.id)
      const key = str(f.fieldKey)
      if (id && key) c.fieldKeys.set(id, key.replace(/^contact\./, ''))
      await upsertRecord(c, 'custom_field', id, str(f.name) ?? key ?? 'Field', f)
      ph.count++
    }
  },

  async customValues(c, ph) {
    const r = await ghl(c, `/locations/${c.locationId}/customValues`)
    for (const v of listIn(r, ['customValues'])) {
      await upsertRecord(c, 'custom_value', str(v.id), str(v.name) ?? 'Value', v)
      ph.count++
    }
  },

  async pipelines(c, ph) {
    const r = await ghl(c, `/opportunities/pipelines?locationId=${c.locationId}`)
    for (const p of listIn(r, ['pipelines'])) {
      const ghlId = str(p.id)
      if (!ghlId) continue
      const stages: HlStage[] = listIn(p.stages, [])
        .slice()
        .sort((a, b) => (num(a.position) ?? 0) - (num(b.position) ?? 0))
        .map((s) => ({ id: str(s.id) ?? `stage-${Math.random().toString(36).slice(2, 8)}`, name: str(s.name) ?? 'Stage' }))
      const name = str(p.name) ?? 'Pipeline'
      await prisma.hlPipeline.upsert({
        where: { accountId_ghlId: { accountId: c.accountId, ghlId } },
        create: { accountId: c.accountId, ghlId, name, stages: stages as unknown as Prisma.InputJsonValue },
        update: { name, stages: stages as unknown as Prisma.InputJsonValue },
      })
      ph.count++
    }
  },

  async contacts(c, ph) {
    let startAfterId = str(ph.cursor?.startAfterId)
    let startAfter = str(ph.cursor?.startAfter)
    for (let page = 0; page < 2000; page++) {
      const q = new URLSearchParams({ locationId: c.locationId, limit: '100' })
      if (startAfterId) q.set('startAfterId', startAfterId)
      if (startAfter) q.set('startAfter', startAfter)
      const r = await ghl(c, `/contacts/?${q}`)
      const list = listIn(r, ['contacts'])
      for (const x of list) await upsertGhlContact(c, x)
      ph.count += list.length
      const meta = rec(r.meta)
      const nextId = str(meta.startAfterId) ?? str(list.at(-1)?.id)
      const nextAfter = str(meta.startAfter)
      if (list.length < 100 || !nextId || nextId === startAfterId) break
      startAfterId = nextId
      startAfter = nextAfter
      ph.cursor = { startAfterId, startAfter }
      await c.save()
    }
  },

  async opportunities(c, ph) {
    const pipelines = await prisma.hlPipeline.findMany({ where: { accountId: c.accountId, ghlId: { not: null } }, select: { id: true, ghlId: true, stages: true } })
    const byGhl = new Map(pipelines.map((p) => [p.ghlId!, p]))
    let page = num(ph.cursor?.page) ?? 1
    for (let i = 0; i < 1000; i++, page++) {
      const q = new URLSearchParams({ location_id: c.locationId, limit: '100', page: String(page) })
      const r = await ghl(c, `/opportunities/search?${q}`)
      const list = listIn(r, ['opportunities'])
      for (const o of list) {
        const ghlId = str(o.id)
        const pipeline = byGhl.get(str(o.pipelineId) ?? '')
        if (!ghlId || !pipeline) continue
        const stages = (pipeline.stages as HlStage[]) ?? []
        const stageId = stages.some((s) => s.id === o.pipelineStageId) ? String(o.pipelineStageId) : (stages[0]?.id ?? 'new')
        const contactId = await contactIdFor(c, str(o.contactId) ?? str(rec(o.contact).id), rec(o.contact))
        if (!contactId) continue
        const status = ['open', 'won', 'lost', 'abandoned'].includes(String(o.status)) ? String(o.status) : 'open'
        const data = {
          pipelineId: pipeline.id,
          stageId,
          contactId,
          name: (str(o.name) ?? 'Opportunity').slice(0, 300),
          value: Math.round(num(o.monetaryValue) ?? 0),
          status,
          source: str(o.source),
          assignedTo: c.users.get(str(o.assignedTo) ?? '') ?? null,
          closedAt: status === 'open' ? null : when(o.lastStatusChangeAt),
        }
        await prisma.hlOpportunity.upsert({
          where: { accountId_ghlId: { accountId: c.accountId, ghlId } },
          create: { accountId: c.accountId, ghlId, ...data, position: (when(o.createdAt)?.getTime() ?? Date.now()) / 1000, createdAt: when(o.createdAt) ?? undefined },
          update: data,
        })
        ph.count++
      }
      if (list.length < 100) break
      ph.cursor = { page: page + 1 }
      await c.save()
    }
  },

  async conversations(c, ph) {
    let startAfterDate = str(ph.cursor?.startAfterDate)
    for (let page = 0; page < 2000; page++) {
      const q = new URLSearchParams({ locationId: c.locationId, limit: '100' })
      if (startAfterDate) q.set('startAfterDate', startAfterDate)
      const r = await ghl(c, `/conversations/search?${q}`)
      const list = listIn(r, ['conversations'])
      for (const conv of list) {
        await importConversation(c, conv)
        ph.count++
        if (ph.count % 10 === 0) await c.save()
      }
      const last = list.at(-1)
      const next = last ? String(num(last.lastMessageDate) ?? when(last.lastMessageDate)?.getTime() ?? '') : ''
      if (list.length < 100 || !next || next === startAfterDate) break
      startAfterDate = next
      ph.cursor = { startAfterDate }
      await c.save(true)
    }
  },

  async notesTasks(c, ph) {
    let afterId = str(ph.cursor?.afterId)
    let notes = num(ph.cursor?.notes) ?? 0
    let tasks = num(ph.cursor?.tasks) ?? 0
    let tasksAllowed = true
    let notesAllowed = true
    for (;;) {
      const batch = await prisma.hlContact.findMany({
        where: { accountId: c.accountId, ghlId: { not: null }, ...(afterId ? { id: { gt: afterId } } : {}) },
        orderBy: { id: 'asc' },
        take: 50,
        select: { id: true, ghlId: true },
      })
      if (!batch.length) break
      for (const ct of batch) {
        if (notesAllowed) {
          try {
            const r = await ghl(c, `/contacts/${ct.ghlId}/notes`)
            for (const n of listIn(r, ['notes'])) {
              const id = str(n.id)
              if (!id || !str(n.body)) continue
              await prisma.hlMessage.upsert({
                where: { providerSid: `ghl-note:${id}` },
                create: {
                  accountId: c.accountId,
                  contactId: ct.id,
                  direction: 'outbound',
                  channel: 'note',
                  status: 'logged',
                  body: String(n.body).slice(0, 8000),
                  providerSid: `ghl-note:${id}`,
                  by: c.users.get(str(n.userId) ?? '') ?? 'GHL',
                  createdAt: when(n.dateAdded) ?? undefined,
                },
                update: { body: String(n.body).slice(0, 8000) },
              })
              notes++
            }
          } catch (err) {
            if (err instanceof GhlError && (err.status === 401 || err.status === 403)) notesAllowed = false
            else if (!(err instanceof GhlError && err.status === 404)) throw err
          }
        }
        if (tasksAllowed) {
          try {
            const r = await ghl(c, `/contacts/${ct.ghlId}/tasks`)
            for (const t of listIn(r, ['tasks'])) {
              const ghlId = str(t.id)
              if (!ghlId) continue
              const data = {
                contactId: ct.id,
                title: (str(t.title) ?? 'Task').slice(0, 300),
                body: str(t.body),
                dueDate: when(t.dueDate),
                completed: t.completed === true,
                assignedTo: c.users.get(str(t.assignedTo) ?? '') ?? null,
              }
              await prisma.hlTask.upsert({
                where: { accountId_ghlId: { accountId: c.accountId, ghlId } },
                create: { accountId: c.accountId, ghlId, ...data },
                update: data,
              })
              tasks++
            }
          } catch (err) {
            if (err instanceof GhlError && (err.status === 401 || err.status === 403)) tasksAllowed = false
            else if (!(err instanceof GhlError && err.status === 404)) throw err
          }
        }
        if (!notesAllowed && !tasksAllowed) throw new GhlError(403, 'Notes and tasks are not readable with this key')
      }
      afterId = batch.at(-1)!.id
      ph.count = notes + tasks
      ph.detail = `${notes} notes, ${tasks} tasks${notesAllowed ? '' : ' (notes not readable with this key)'}${tasksAllowed ? '' : ' (tasks not readable with this key)'}`
      ph.cursor = { afterId, notes, tasks }
      await c.save(true)
    }
  },

  async calendars(c, ph) {
    // Calendar groups first (the calendars point at them by GHL id). An account without any answers with none.
    const groups = await ghl(c, `/calendars/groups?locationId=${c.locationId}`).catch(() => null)
    for (const g of listIn(groups, ['groups'])) {
      const ghlId = str(g.id)
      if (!ghlId) continue
      const data = json({ description: str(g.description) ?? '', slug: str(g.slug) ?? '', isActive: g.isActive !== false })
      await prisma.hlRecord.upsert({
        where: { accountId_kind_ghlId: { accountId: c.accountId, kind: 'calendar_group', ghlId } },
        create: { accountId: c.accountId, kind: 'calendar_group', ghlId, name: str(g.name) ?? 'Group', data },
        update: { name: str(g.name) ?? 'Group', data },
      })
    }
    const r = await ghl(c, `/calendars/?locationId=${c.locationId}`)
    let appointments = 0
    for (const cal of listIn(r, ['calendars'])) {
      const ghlId = str(cal.id)
      if (!ghlId) continue
      const settings = cal
      const row = await prisma.hlCalendar.upsert({
        where: { accountId_ghlId: { accountId: c.accountId, ghlId } },
        create: { accountId: c.accountId, ghlId, name: str(cal.name) ?? 'Calendar', description: str(cal.description), kind: str(cal.calendarType), isActive: cal.isActive !== false, settings: json(settings) },
        update: { name: str(cal.name) ?? 'Calendar', description: str(cal.description), kind: str(cal.calendarType), isActive: cal.isActive !== false, settings: json(settings) },
      })
      ph.count++
      // Appointments from 18 months back to a year ahead, a month at a time.
      const DAY = 86_400_000
      for (let from = Date.now() - 540 * DAY; from < Date.now() + 365 * DAY; from += 30 * DAY) {
        const q = new URLSearchParams({ locationId: c.locationId, calendarId: ghlId, startTime: String(from), endTime: String(from + 30 * DAY) })
        const ev = await ghl(c, `/calendars/events?${q}`)
        for (const e of listIn(ev, ['events'])) {
          const eid = str(e.id)
          const start = when(e.startTime)
          const end = when(e.endTime) ?? (start ? new Date(start.getTime() + 30 * 60_000) : null)
          if (!eid || !start || !end) continue
          const data = {
            calendarId: row.id,
            contactId: await contactIdFor(c, str(e.contactId)),
            title: (str(e.title) ?? 'Appointment').slice(0, 300),
            startTime: start,
            endTime: end,
            status: str(e.appointmentStatus) ?? 'confirmed',
            assignedTo: c.users.get(str(e.assignedUserId) ?? '') ?? null,
            assignedUserId: str(e.assignedUserId),
            address: str(e.address),
            notes: str(e.notes),
            source: 'ghl',
          }
          await prisma.hlAppointment.upsert({
            where: { accountId_ghlId: { accountId: c.accountId, ghlId: eid } },
            create: { accountId: c.accountId, ghlId: eid, ...data },
            update: data,
          })
          appointments++
        }
        await c.save()
      }
    }
    ph.detail = `${ph.count} calendars, ${appointments} appointments`
  },

  async workflows(c, ph) {
    const r = await ghl(c, `/workflows/?locationId=${c.locationId}`)
    for (const w of listIn(r, ['workflows'])) {
      const ghlId = str(w.id)
      if (!ghlId) continue
      const meta = { ghlStatus: str(w.status), ghlVersion: num(w.version), ghlUpdatedAt: str(w.updatedAt) }
      await prisma.hlWorkflow.upsert({
        where: { accountId_ghlId: { accountId: c.accountId, ghlId } },
        create: {
          accountId: c.accountId,
          ghlId,
          name: (str(w.name) ?? 'Workflow').slice(0, 200),
          folder: 'Imported from GoHighLevel',
          status: 'draft',
          trigger: { type: 'manual' },
          steps: [],
          meta: json(meta),
          createdAt: when(w.createdAt) ?? undefined,
        },
        update: { name: (str(w.name) ?? 'Workflow').slice(0, 200), meta: json(meta) },
      })
      ph.count++
    }
    ph.detail = `${ph.count} workflows by name (GHL’s API doesn’t give their steps)`
  },

  async forms(c, ph) {
    let submissions = 0
    for (let skip = 0, guard = 0; guard < 50; guard++) {
      const r = await ghl(c, `/forms/?locationId=${c.locationId}&limit=50&skip=${skip}`)
      const list = listIn(r, ['forms'])
      for (const f of list) {
        const ghlId = str(f.id)
        if (!ghlId) continue
        const form = await prisma.hlForm.upsert({
          where: { accountId_ghlId: { accountId: c.accountId, ghlId } },
          create: { accountId: c.accountId, ghlId, name: str(f.name) ?? 'Form', kind: 'form', fields: [], settings: { imported: true } },
          update: { name: str(f.name) ?? 'Form' },
        })
        ph.count++
        for (let page = 1; page < 200; page++) {
          const s = await ghl(c, `/forms/submissions?locationId=${c.locationId}&formId=${ghlId}&limit=100&page=${page}`)
          const subs = listIn(s, ['submissions'])
          for (const sub of subs) {
            const sid = str(sub.id)
            if (!sid) continue
            const others = rec(sub.others)
            const flat: Rec = { name: sub.name, email: sub.email }
            for (const [k, v] of Object.entries(others)) if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') flat[k] = v
            await prisma.hlFormSubmission.upsert({
              where: { ghlId: sid },
              create: { ghlId: sid, formId: form.id, accountId: c.accountId, contactId: await contactIdFor(c, str(sub.contactId)), data: json(flat), createdAt: when(sub.createdAt) ?? undefined },
              update: { data: json(flat) },
            })
            submissions++
          }
          if (subs.length < 100) break
        }
        await c.save()
      }
      if (list.length < 50) break
      skip += list.length
    }
    ph.detail = `${ph.count} forms, ${submissions} submissions`
  },

  async surveys(c, ph) {
    await importList(c, ph, { kind: 'survey', path: () => `/surveys/?locationId=${c.locationId}`, keys: ['surveys'], name: (r) => str(r.name) })
  },

  async funnels(c, ph) {
    await importList(c, ph, {
      kind: (r) => (String(r.type ?? '').toLowerCase() === 'website' ? 'website' : 'funnel'),
      path: (o) => `/funnels/funnel/list?locationId=${c.locationId}&limit=50&offset=${o}`,
      keys: ['funnels'],
      name: (r) => str(r.name),
      pageSize: 50,
    })
  },

  async media(c, ph) {
    await importList(c, ph, {
      kind: 'media',
      path: (o) => `/medias/files?altId=${c.locationId}&altType=location&sortBy=createdAt&sortOrder=desc&type=file&limit=100&offset=${o}`,
      keys: ['files', 'medias'],
      name: (r) => str(r.name),
      pageSize: 100,
      maxPages: 100,
    })
  },

  async payments(c, ph) {
    const lists: { kind: string; path: (o: number) => string; keys: string[]; name: (r: Rec) => string | null }[] = [
      { kind: 'product', path: (o) => `/products/?locationId=${c.locationId}&limit=100&offset=${o}`, keys: ['products'], name: (r) => str(r.name) },
      { kind: 'invoice', path: (o) => `/invoices/?altId=${c.locationId}&altType=location&limit=100&offset=${o}`, keys: ['invoices'], name: (r) => str(r.name) ?? str(r.invoiceNumber) },
      { kind: 'order', path: (o) => `/payments/orders?altId=${c.locationId}&altType=location&limit=100&offset=${o}`, keys: ['data', 'orders'], name: (r) => str(r.contactName) ?? str(r.name) },
      { kind: 'transaction', path: (o) => `/payments/transactions?altId=${c.locationId}&altType=location&limit=100&offset=${o}`, keys: ['data', 'transactions'], name: (r) => str(r.contactName) ?? str(r.entitySourceName) },
      { kind: 'subscription', path: (o) => `/payments/subscriptions?altId=${c.locationId}&altType=location&limit=100&offset=${o}`, keys: ['data', 'subscriptions'], name: (r) => str(r.contactName) ?? str(r.entitySourceName) },
      { kind: 'coupon', path: (o) => `/payments/coupon/list?altId=${c.locationId}&altType=location&limit=100&offset=${o}`, keys: ['data', 'coupons'], name: (r) => str(r.name) ?? str(r.code) },
    ]
    const notes: string[] = []
    for (const l of lists) {
      const sub: PhaseState = { status: 'running', count: 0 }
      try {
        await importList(c, sub, { ...l, pageSize: 100, maxPages: 50 })
        notes.push(`${sub.count} ${l.kind}s`)
      } catch (err) {
        notes.push(`${l.kind}s: ${err instanceof GhlError && (err.status === 401 || err.status === 403) ? 'not readable with this key' : 'not available'}`)
      }
      ph.count += sub.count
    }
    ph.detail = notes.join(', ')
  },

  async links(c, ph) {
    await importList(c, ph, { kind: 'trigger_link', path: () => `/links/?locationId=${c.locationId}`, keys: ['links'], name: (r) => str(r.name) })
  },

  async snippets(c, ph) {
    await importList(c, ph, {
      kind: 'snippet',
      path: (o) => `/locations/${c.locationId}/templates?originId=${c.locationId}&deleted=false&skip=${o}&limit=100`,
      keys: ['templates'],
      name: (r) => str(r.name),
      pageSize: 100,
    })
  },

  async companies(c, ph) {
    await importList(c, ph, { kind: 'company', path: () => `/businesses/?locationId=${c.locationId}`, keys: ['businesses'], name: (r) => str(r.name) })
  },

  async finish(c, ph) {
    // Writing or calling first counts as wanting a reply (as for live leads).
    const inbound = await prisma.hlMessage.findMany({
      where: { accountId: c.accountId, direction: 'inbound', channel: { in: ['sms', 'call'] } },
      distinct: ['contactId'],
      select: { contactId: true },
    })
    for (let i = 0; i < inbound.length; i += 500) {
      await prisma.hlContact.updateMany({ where: { id: { in: inbound.slice(i, i + 500).map((m) => m.contactId) }, smsConsent: false }, data: { smsConsent: true } })
    }
    ph.count = inbound.length
    ph.detail = `${inbound.length} contacts who texted or called marked as agreeing to texts`
  },
}

async function upsertGhlContact(c: Ctx, x: Rec) {
  const ghlId = str(x.id)
  if (!ghlId) return
  const fields: Rec = {}
  const put = (k: string, v: unknown) => {
    const s = str(v)
    if (s) fields[k] = s
  }
  put('company_name', x.companyName)
  put('address1', x.address1)
  put('city', x.city)
  put('state', x.state)
  put('postal_code', x.postalCode)
  put('country', x.country)
  put('website', x.website)
  put('timezone', x.timezone)
  put('date_of_birth', x.dateOfBirth)
  put('type', x.type)
  put('assigned_to', c.users.get(str(x.assignedTo) ?? '') ?? null)
  for (const cf of listIn(x.customFields, [])) {
    const key = c.fieldKeys.get(str(cf.id) ?? '') ?? str(cf.id)
    const value = cf.value ?? cf.fieldValue
    if (key && value !== undefined && value !== null && value !== '') fields[key] = Array.isArray(value) ? value.join(', ') : typeof value === 'object' ? JSON.stringify(value) : value
  }
  const first = str(x.firstName) ?? splitName(str(x.contactName) ?? str(x.name)).firstName
  const last = str(x.lastName) ?? (str(x.firstName) ? null : splitName(str(x.contactName) ?? str(x.name)).lastName)
  const sms = rec(rec(x.dndSettings).SMS)
  const data = {
    firstName: first,
    lastName: last,
    phone: toE164(str(x.phone)),
    email: str(x.email)?.toLowerCase() ?? null,
    tags: Array.isArray(x.tags) ? x.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim().toLowerCase()).filter(Boolean) : [],
    source: str(x.source) ?? 'ghl',
    dnd: x.dnd === true || String(sms.status).toLowerCase() === 'active',
    fields: json(fields),
  }
  const row = await prisma.hlContact.upsert({
    where: { accountId_ghlId: { accountId: c.accountId, ghlId } },
    create: { accountId: c.accountId, ghlId, ...data, createdAt: when(x.dateAdded) ?? undefined },
    update: data,
    select: { id: true },
  })
  c.contactIds.set(ghlId, row.id)
}

async function importConversation(c: Ctx, conv: Rec) {
  const convId = str(conv.id)
  const contactId = await contactIdFor(c, str(conv.contactId), conv)
  if (!convId || !contactId) return
  let lastMessageId: string | null = null
  let imported = 0
  let newest: { at: Date; body: string } | null = null
  for (let page = 0; page < Math.ceil(MESSAGE_CAP / 100); page++) {
    const q = new URLSearchParams({ limit: '100' })
    if (lastMessageId) q.set('lastMessageId', lastMessageId)
    const r = await ghl(c, `/conversations/${convId}/messages?${q}`)
    const box = rec(r.messages)
    const list = listIn(r, ['messages'])
    for (const m of list) {
      const id = str(m.id)
      if (!id) continue
      const channel = channelOf(m)
      const direction = String(m.direction ?? '').toLowerCase() === 'inbound' ? 'inbound' : 'outbound'
      const meta = rec(m.meta)
      const call = rec(meta.call)
      const callStatus = String(call.status ?? m.status ?? '').toLowerCase()
      const duration = num(call.duration) ?? 0
      let body = str(m.body) ?? ''
      let status = String(m.status ?? (direction === 'inbound' ? 'received' : 'sent')).toLowerCase()
      if (channel === 'call') {
        const answered = callStatus === 'completed' && duration > 0
        status = answered ? 'answered' : 'missed'
        body = answered ? `Answered call (${Math.max(1, Math.round(duration / 60))} min)` : direction === 'inbound' ? 'Missed call' : 'Outgoing call'
      } else if (channel === 'email') {
        body = body || str(rec(meta.email).subject) || '(email)'
      } else if (channel === 'sms' && direction === 'inbound') {
        status = 'received'
      }
      const at = when(m.dateAdded) ?? new Date()
      await prisma.hlMessage.upsert({
        where: { providerSid: `ghl:${id}` },
        create: {
          accountId: c.accountId,
          contactId,
          direction,
          channel,
          body: body.slice(0, 8000),
          status,
          providerSid: `ghl:${id}`,
          by: direction === 'outbound' ? (c.users.get(str(m.userId) ?? '') ?? (str(m.source) === 'workflow' ? 'automation' : 'GHL')) : null,
          meta: json({ ghlType: m.messageType ?? m.type, source: m.source, attachments: Array.isArray(m.attachments) ? m.attachments : undefined, duration: duration || undefined }),
          createdAt: at,
        },
        update: {},
      })
      imported++
      if (!newest || at > newest.at) newest = { at, body }
    }
    lastMessageId = str(box.lastMessageId)
    if (box.nextPage !== true || !lastMessageId || list.length < 100) break
  }
  const lastAt = when(conv.lastMessageDate) ?? newest?.at ?? null
  if (lastAt || imported) {
    await prisma.hlContact.update({
      where: { id: contactId },
      data: {
        lastMessageAt: lastAt ?? undefined,
        lastMessage: (str(conv.lastMessageBody) ?? newest?.body ?? '').slice(0, 200) || undefined,
        unread: Math.max(0, num(conv.unreadCount) ?? 0),
      },
    })
  }
}
