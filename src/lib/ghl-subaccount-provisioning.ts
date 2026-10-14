/**
 * A GHL sub-account for every new client from the onboarding form.
 *
 * When a new submission becomes a new Client (src/lib/client-intake-ingest.ts),
 * this creates their sub-account in the agency — named "Contractor: Business"
 * ("Randy: J&R Painting") — with the onboarding snapshot loaded, and links
 * it on the Client (ghlLocationId, ghlSubaccountUrl).
 *
 * Only NEW submissions: anything received before the automation was
 * switched on is left alone, so clients who already have a sub-account
 * never get a second one. Turning it off and on again moves that line to
 * the moment it was turned back on.
 *
 * Never throws — failures are stored on the Client and posted to
 * #genisys-alerts, and can be retried from Settings → GHL sub-accounts.
 */
import { prisma } from './prisma'
import { hubAlert, hubLink } from './hub-alerts'
import { parseAddress, STATE_CODE_TO_NAME } from './address'
import { parseTimezoneInput, stateCodeFromAddress, timezoneForAddress } from './timezone'
import {
  createLocation,
  getAgencyContext,
  getLocation,
  getSnapshotPushStatus,
  GhlAgencyError,
  listAllLocations,
  listSnapshots,
  searchLocations,
  type AgencyContext,
  type AgencySnapshot,
  type CompanyIdSource,
  type CreateLocationInput,
} from './ghl-agency'

// -------------------------------------------------------------------------
// Settings
// -------------------------------------------------------------------------

const SETTINGS_KEY = 'ghlSubaccounts.settings'

/** The snapshot Genisys loads onto every new client sub-account. */
export const DEFAULT_SNAPSHOT_ID = 'pHagdFFJPsZBnn8ACSHK'

export type GhlSubaccountSettings = {
  enabled: boolean
  snapshotId: string
  /** Submissions received before this (ISO) are never provisioned automatically. */
  since: string
}

function parseSettings(value: string | null | undefined): Partial<GhlSubaccountSettings> {
  if (!value) return {}
  try {
    const v = JSON.parse(value) as Record<string, unknown>
    return {
      ...(typeof v.enabled === 'boolean' ? { enabled: v.enabled } : {}),
      ...(typeof v.snapshotId === 'string' && v.snapshotId.trim() ? { snapshotId: v.snapshotId.trim() } : {}),
      ...(typeof v.since === 'string' && !Number.isNaN(Date.parse(v.since)) ? { since: v.since } : {}),
    }
  } catch {
    return {}
  }
}

/**
 * When the automation shipped. Every client from before it already has
 * (or was deliberately given no) sub-account, and their submissions are
 * already stored, so nothing older is ever treated as new.
 */
const AUTOMATION_LIVE_AT = '2026-10-13T15:30:00.000Z'

export async function getGhlSubaccountSettings(): Promise<GhlSubaccountSettings> {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } })
  const stored = parseSettings(row?.value)
  return {
    enabled: stored.enabled ?? true,
    snapshotId: stored.snapshotId ?? DEFAULT_SNAPSHOT_ID,
    since: stored.since ?? AUTOMATION_LIVE_AT,
  }
}

export async function updateGhlSubaccountSettings(
  patch: { enabled?: boolean; snapshotId?: string },
): Promise<GhlSubaccountSettings> {
  const current = await getGhlSubaccountSettings()
  const next: GhlSubaccountSettings = {
    enabled: patch.enabled ?? current.enabled,
    snapshotId: patch.snapshotId?.trim() || current.snapshotId,
    // Switching back on must not reach back for what arrived while it was off.
    since: patch.enabled === true && !current.enabled ? new Date().toISOString() : current.since,
  }
  await prisma.appSetting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  })
  return next
}

// -------------------------------------------------------------------------
// Building the sub-account from the onboarding answers
// -------------------------------------------------------------------------

function firstNameOf(fullName: string | null | undefined): string | null {
  const first = fullName?.trim().split(/\s+/)[0]?.replace(/[.,;:]+$/, '')
  if (!first) return null
  // "randy" → "Randy"; anything with capitals in it is left as they typed it.
  return first === first.toLowerCase() ? first.charAt(0).toUpperCase() + first.slice(1) : first
}

function lastNameOf(fullName: string | null | undefined): string | null {
  const parts = fullName?.trim().split(/\s+/) ?? []
  return parts.length > 1 ? parts.slice(1).join(' ') : null
}

/** "Randy Smith" + "J&R Painting" → "Randy: J&R Painting". Just the business when there's no name. */
export function subAccountName(contactName: string | null | undefined, businessName: string): string {
  const first = firstNameOf(contactName)
  const business = businessName.trim()
  return first ? `${first}: ${business}` : business
}

const normalizeName = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

/** First phone number in the text, as +1XXXXXXXXXX. */
function toE164(raw: string | null | undefined): string | undefined {
  const match = raw?.match(/\+?\d[\d\s().-]{8,}\d/)?.[0]
  if (!match) return undefined
  const digits = match.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (match.startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`
  return undefined
}

function websiteUrl(raw: string | null | undefined): string | undefined {
  const first = raw?.trim().split(/[\s,]+/)[0]
  if (!first || !/\.[a-z]{2,}/i.test(first)) return undefined
  return /^https?:\/\//i.test(first) ? first : `https://${first}`
}

const ZONE_WORDS: Array<[RegExp, string]> = [
  [/arizona/i, 'America/Phoenix'],
  [/hawaii/i, 'Pacific/Honolulu'],
  [/alaska/i, 'America/Anchorage'],
  [/pacific|\bp[sd]?t\b/i, 'America/Los_Angeles'],
  [/mountain|\bm[sd]?t\b/i, 'America/Denver'],
  [/central|\bc[sd]?t\b/i, 'America/Chicago'],
  [/eastern|\be[sd]?t\b/i, 'America/New_York'],
]

/** "Eastern", "PST", "Central time", "America/Chicago" → IANA; else from the address' state. */
function timezoneFor(answer: string | null | undefined, address: string | null | undefined): string | undefined {
  const parsed = parseTimezoneInput(answer)
  if (parsed) return parsed
  const word = answer ? ZONE_WORDS.find(([re]) => re.test(answer))?.[1] : undefined
  if (word) return word
  return stateCodeFromAddress(address) ? timezoneForAddress(address) : undefined
}

function addressFields(raw: string | null | undefined): Pick<CreateLocationInput, 'address' | 'city' | 'state' | 'postalCode'> {
  if (!raw?.trim()) return {}
  const parts = parseAddress(raw)
  const code = (parts.state || stateCodeFromAddress(raw) || '').toUpperCase()
  const state = STATE_CODE_TO_NAME[code] ?? undefined
  const postalCode = parts.zip || raw.trim().match(/\b(\d{5}(?:-\d{4})?)\s*(?:,?\s*(?:USA?|United States))?$/i)?.[1] || undefined
  // A clean "Street, City, ST 12345" splits; anything looser goes in whole.
  const clean = parts.street && parts.city && parts.state && !/\d{5}/.test(parts.city)
  return clean
    ? { address: parts.street, city: parts.city, state, postalCode }
    : { address: raw.trim().replace(/\s*\n\s*/g, ', '), state, postalCode }
}

type ClientForGhl = {
  id: string
  name: string
  contactName: string | null
  contactEmail: string | null
  contactPhone: string | null
  address: string | null
  website: string | null
}

type IntakeForGhl = {
  fullName: string | null
  leadEmail: string | null
  customerPhone: string | null
  businessAddress: string | null
  website: string | null
  timeZone: string | null
} | null

/** The sub-account GHL is asked to create. The Client's fields win — the team may have corrected them. */
export function buildLocationInput(
  client: ClientForGhl,
  intake: IntakeForGhl,
  snapshotId: string,
): CreateLocationInput {
  const contactName = client.contactName ?? intake?.fullName ?? null
  const address = client.address ?? intake?.businessAddress ?? null
  const first = firstNameOf(contactName)
  const last = lastNameOf(contactName)
  const email = client.contactEmail ?? intake?.leadEmail ?? null
  const input: CreateLocationInput = {
    name: subAccountName(contactName, client.name),
    snapshotId,
    country: 'US',
    phone: toE164(client.contactPhone ?? intake?.customerPhone),
    website: websiteUrl(client.website ?? intake?.website),
    timezone: timezoneFor(intake?.timeZone, address),
    ...addressFields(address),
    // GHL wants all three or none.
    ...(first && last && email ? { prospectInfo: { firstName: first, lastName: last, email } } : {}),
  }
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as CreateLocationInput
}

/**
 * Fields GHL may reject for formatting reasons. When it does, the
 * sub-account is created without that one rather than not at all —
 * the snapshot and the name are what matter, and the team can fill a
 * detail in by hand.
 */
const DROPPABLE: Array<[RegExp, keyof CreateLocationInput]> = [
  [/time\s*zone/i, 'timezone'],
  [/phone/i, 'phone'],
  [/postal|zip/i, 'postalCode'],
  [/website|url/i, 'website'],
  [/prospect|first\s*name|last\s*name|email/i, 'prospectInfo'],
  [/\bstate\b/i, 'state'],
  [/\bcity\b/i, 'city'],
  [/country/i, 'country'],
  [/address/i, 'address'],
]

async function createWithFallback(
  ctx: AgencyContext,
  input: CreateLocationInput,
): Promise<{ id: string; dropped: string[] }> {
  const body = { ...input }
  const dropped: string[] = []
  for (let attempt = 0; ; attempt++) {
    try {
      const created = await createLocation(ctx, body)
      return { id: created.id, dropped }
    } catch (err) {
      // Only validation errors are safe to retry: GHL created nothing.
      const validation = err instanceof GhlAgencyError && (err.status === 400 || err.status === 422)
      if (!validation || attempt >= 3 || /snapshot/i.test(err.message)) throw err
      const fields = DROPPABLE.filter(([re, key]) => re.test(err.message) && key in body).map(([, key]) => key)
      if (fields.length === 0) throw err
      for (const key of fields) {
        delete body[key]
        dropped.push(key)
      }
    }
  }
}

// -------------------------------------------------------------------------
// Provisioning
// -------------------------------------------------------------------------

export function ghlLocationUrl(locationId: string): string {
  return `https://app.gohighlevel.com/v2/location/${locationId}/dashboard`
}

const STALE_CLAIM_MS = 10 * 60 * 1000
const SNAPSHOT_FOLLOW_UP_MS = 3 * 60 * 1000

export type ProvisionResult =
  | { ok: true; status: 'created' | 'linked'; locationId: string; name: string }
  | { ok: false; status: 'skipped' | 'failed'; reason: string }

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Called for each brand-new Client from an onboarding submission.
 * Skips (silently) when the automation is off or the submission predates it.
 */
export async function provisionGhlSubAccountForNewClient(
  clientId: string,
  receivedAt: Date,
  opts: { timeKnown: boolean },
): Promise<ProvisionResult> {
  try {
    const settings = await getGhlSubaccountSettings()
    if (!settings.enabled) return { ok: false, status: 'skipped', reason: 'automation is off' }
    if (receivedAt.getTime() < Date.parse(settings.since)) {
      return { ok: false, status: 'skipped', reason: 'submission is from before the automation was switched on' }
    }
    // A sheet row without a readable timestamp is stamped "now" on import,
    // so it could be an old submission. Leave it for the team to decide.
    if (!opts.timeKnown) {
      const reason =
        "the onboarding sheet row had no readable submission time, so it may be an old submission — press Retry if it's a new client"
      const held = await prisma.client.updateMany({
        where: { id: clientId, ghlLocationId: null, ghlProvisionStatus: null },
        data: { ghlProvisionStatus: 'failed', ghlProvisionError: reason, ghlProvisionedAt: new Date() },
      })
      if (held.count > 0) {
        await hubAlert(
          `:hourglass: *GHL sub-account not created yet* — ${reason}. <${hubLink('/settings')}|Settings → GHL sub-accounts>`,
        )
      }
      return { ok: false, status: 'skipped', reason }
    }
    return await provisionGhlSubAccount(clientId, { manual: false, snapshotId: settings.snapshotId })
  } catch (err) {
    console.error(`[ghl-subaccount] ${clientId}:`, err)
    return { ok: false, status: 'failed', reason: describe(err) }
  }
}

/**
 * Create (or link) the client's GHL sub-account. `manual` is the retry
 * from Settings: it may pick up a failed or stuck attempt, where the
 * automatic path only ever makes the first one.
 */
export async function provisionGhlSubAccount(
  clientId: string,
  opts: { manual: boolean; snapshotId?: string },
): Promise<ProvisionResult> {
  const now = new Date()
  const claim = await prisma.client.updateMany({
    where: {
      id: clientId,
      ghlLocationId: null,
      OR: opts.manual
        ? [
            { ghlProvisionStatus: null },
            { ghlProvisionStatus: 'failed' },
            { ghlProvisionStatus: 'creating', ghlProvisionedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } },
          ]
        : [{ ghlProvisionStatus: null }],
    },
    data: { ghlProvisionStatus: 'creating', ghlProvisionError: null, ghlProvisionedAt: now },
  })
  if (claim.count === 0) {
    return { ok: false, status: 'skipped', reason: 'already has a sub-account, or one is being created right now' }
  }

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true, name: true, contactName: true, contactEmail: true, contactPhone: true,
      address: true, website: true, ghlSubaccountUrl: true,
    },
  })
  if (!client) return { ok: false, status: 'failed', reason: 'client not found' }

  const intake = await prisma.clientIntake.findFirst({
    where: { clientId },
    orderBy: { receivedAt: 'desc' },
    select: { fullName: true, leadEmail: true, customerPhone: true, businessAddress: true, website: true, timeZone: true },
  })

  const snapshotId = opts.snapshotId ?? (await getGhlSubaccountSettings()).snapshotId
  const input = buildLocationInput(client, intake, snapshotId)
  const hubUrl = hubLink(`/clients?focus=${client.id}`)

  const fail = async (reason: string): Promise<ProvisionResult> => {
    await prisma.client
      .update({ where: { id: client.id }, data: { ghlProvisionStatus: 'failed', ghlProvisionError: reason } })
      .catch((err) => console.error(`[ghl-subaccount] couldn't record failure for ${client.id}:`, err))
    await hubAlert(
      `:warning: *Couldn't create the GHL sub-account* for *${input.name}* — ${reason}\nRetry from <${hubLink('/settings')}|Settings → GHL sub-accounts> once it's sorted. <${hubUrl}|Open client>`,
    )
    return { ok: false, status: 'failed', reason }
  }

  try {
    const ctx = await getAgencyContext()

    // Load the snapshot or don't create it: a sub-account without it is
    // worse than none, because it looks done.
    let snapshot: AgencySnapshot | undefined
    try {
      const snapshots = await listSnapshots(ctx)
      snapshot = snapshots.find((s) => s.id === snapshotId)
      if (!snapshot) {
        return await fail(
          `snapshot ${snapshotId} isn't in the agency's snapshot list (${snapshots.length} visible${snapshots.length ? `: ${snapshots.slice(0, 5).map((s) => s.name || s.id).join(', ')}` : ''}). Check the snapshot ID in Settings → GHL sub-accounts.`,
        )
      }
    } catch (err) {
      return await fail(`couldn't read the agency's snapshots to confirm ${snapshotId}: ${describe(err)}`)
    }

    // A sub-account already carrying this exact name is theirs — link it
    // rather than making a second one.
    let existing: { id: string; name: string } | undefined
    let dedupNote = ''
    try {
      const { locations } = await listAllLocations(ctx)
      existing = locations.find((l) => normalizeName(l.name) === normalizeName(input.name))
    } catch (err) {
      dedupNote = ` _(couldn't check for an existing sub-account first: ${describe(err)})_`
    }

    if (existing) {
      await prisma.client.update({
        where: { id: client.id },
        data: {
          ghlLocationId: existing.id,
          ghlProvisionStatus: 'linked',
          ghlProvisionError: null,
          ghlProvisionedAt: new Date(),
          ...(client.ghlSubaccountUrl ? {} : { ghlSubaccountUrl: ghlLocationUrl(existing.id) }),
        },
      })
      await hubAlert(
        `:link: *GHL sub-account already existed* — linked *${existing.name}* to the client instead of creating another (the snapshot wasn't re-loaded). <${ghlLocationUrl(existing.id)}|Open in GHL> · <${hubUrl}|Open client>`,
      )
      return { ok: true, status: 'linked', locationId: existing.id, name: existing.name }
    }

    const { id, dropped } = await createWithFallback(ctx, input)
    await prisma.client.update({
      where: { id: client.id },
      data: {
        ghlLocationId: id,
        ghlProvisionStatus: 'created',
        ghlProvisionError: dropped.length ? `created without: ${dropped.join(', ')} (GHL rejected the format)` : null,
        ghlProvisionedAt: new Date(),
        ghlSnapshotStatus: null,
        ...(client.ghlSubaccountUrl ? {} : { ghlSubaccountUrl: ghlLocationUrl(id) }),
      },
    })

    const notes = [
      !firstNameOf(client.contactName ?? intake?.fullName) ? 'no contractor name on the submission, so it’s named after the business only — rename it in GHL' : null,
      dropped.length ? `GHL rejected the format of: ${dropped.join(', ')} — fill those in by hand` : null,
    ].filter(Boolean)
    await hubAlert(
      `:office: *GHL sub-account created* — *${input.name}*, loading the *${snapshot.name || snapshotId}* snapshot.${notes.length ? `\n• ${notes.join('\n• ')}` : ''}${dedupNote}\n<${ghlLocationUrl(id)}|Open in GHL> · <${hubUrl}|Open client>`,
    )

    setTimeout(() => {
      void refreshSnapshotStatus(client.id, { alertOnFailure: true })
    }, SNAPSHOT_FOLLOW_UP_MS).unref?.()

    return { ok: true, status: 'created', locationId: id, name: input.name }
  } catch (err) {
    const unsure = !(err instanceof GhlAgencyError) || err.status === null || err.status >= 500
    return await fail(
      `${describe(err)}${unsure ? ' — GHL may still have created it; check GHL before retrying (a retry links a sub-account with the same name instead of duplicating it).' : ''}`,
    )
  }
}

/** Ask GHL how loading the snapshot is going, and store the answer. */
export async function refreshSnapshotStatus(
  clientId: string,
  opts: { alertOnFailure?: boolean } = {},
): Promise<string | null> {
  try {
    const client = await prisma.client.findUnique({
      where: { id: clientId },
      select: { name: true, ghlLocationId: true, ghlSnapshotStatus: true },
    })
    if (!client?.ghlLocationId) return null
    const [ctx, settings] = await Promise.all([getAgencyContext(), getGhlSubaccountSettings()])
    const status = await getSnapshotPushStatus(ctx, settings.snapshotId, client.ghlLocationId)
    if (!status) return client.ghlSnapshotStatus
    const pending = status.pending.length ? ` (still loading: ${status.pending.join(', ')})` : ''
    const label = `${status.status}${pending}`.slice(0, 500)
    await prisma.client.update({ where: { id: clientId }, data: { ghlSnapshotStatus: label } })
    if (opts.alertOnFailure && /fail|error/i.test(status.status)) {
      await hubAlert(
        `:warning: *The snapshot didn't load* into *${client.name}*'s GHL sub-account — GHL reports "${status.status}". Load it by hand in GHL. <${ghlLocationUrl(client.ghlLocationId)}|Open in GHL>`,
      )
    }
    return label
  } catch (err) {
    console.warn(`[ghl-subaccount] snapshot status for ${clientId}:`, describe(err))
    return null
  }
}

// -------------------------------------------------------------------------
// Settings panel
// -------------------------------------------------------------------------

export type GhlConnectionCheck = {
  ok: boolean
  problems: string[]
  companyId: string | null
  companyIdSource: CompanyIdSource | null
  snapshot: { id: string; found: boolean; name: string | null; type: string | null }
  snapshots: AgencySnapshot[]
  /** The newest sub-accounts' names, to compare against the naming convention. */
  recentSubAccountNames: string[]
}

/** Everything the agency key can see that this automation depends on. Read-only. */
export async function checkGhlConnection(): Promise<GhlConnectionCheck> {
  const settings = await getGhlSubaccountSettings()
  const result: GhlConnectionCheck = {
    ok: false,
    problems: [],
    companyId: null,
    companyIdSource: null,
    snapshot: { id: settings.snapshotId, found: false, name: null, type: null },
    snapshots: [],
    recentSubAccountNames: [],
  }

  let ctx: AgencyContext
  try {
    ctx = await getAgencyContext({ fresh: true })
  } catch (err) {
    result.problems.push(describe(err))
    return result
  }
  result.companyId = ctx.companyId
  result.companyIdSource = ctx.companyIdSource

  try {
    result.snapshots = await listSnapshots(ctx)
    const match = result.snapshots.find((s) => s.id === settings.snapshotId)
    result.snapshot = { id: settings.snapshotId, found: !!match, name: match?.name ?? null, type: match?.type ?? null }
    if (!match) result.problems.push(`Snapshot ${settings.snapshotId} isn't in this agency's snapshot list.`)
  } catch (err) {
    result.problems.push(`Couldn't list snapshots: ${describe(err)}`)
  }

  try {
    const newest = await searchLocations(ctx, { limit: 15, order: 'desc' })
    result.recentSubAccountNames = newest.map((l) => l.name).filter(Boolean)
  } catch (err) {
    result.problems.push(`Couldn't list sub-accounts: ${describe(err)}`)
  }

  result.ok = result.problems.length === 0
  return result
}

export type GhlProvisionRow = {
  clientId: string
  clientName: string
  status: string
  error: string | null
  locationId: string | null
  url: string | null
  snapshotStatus: string | null
  at: string | null
}

/** The latest automatic (and manual) attempts, refreshing snapshot progress for fresh ones. */
export async function recentGhlProvisioning(limit = 20): Promise<GhlProvisionRow[]> {
  const rows = await prisma.client.findMany({
    where: { ghlProvisionStatus: { not: null } },
    orderBy: { ghlProvisionedAt: 'desc' },
    take: limit,
    select: {
      id: true, name: true, ghlProvisionStatus: true, ghlProvisionError: true, ghlLocationId: true,
      ghlSubaccountUrl: true, ghlSnapshotStatus: true, ghlProvisionedAt: true,
    },
  })

  const dayAgo = Date.now() - 24 * 60 * 60 * 1000
  const needsRefresh = rows.filter(
    (r) =>
      r.ghlProvisionStatus === 'created' &&
      r.ghlProvisionedAt && r.ghlProvisionedAt.getTime() > dayAgo &&
      !/^complete/i.test(r.ghlSnapshotStatus ?? ''),
  ).slice(0, 5)
  const refreshed = new Map<string, string | null>()
  await Promise.all(needsRefresh.map(async (r) => refreshed.set(r.id, await refreshSnapshotStatus(r.id))))

  const attempted: GhlProvisionRow[] = rows.map((r) => ({
    clientId: r.id,
    clientName: r.name,
    status: r.ghlProvisionStatus ?? 'unknown',
    error: r.ghlProvisionError,
    locationId: r.ghlLocationId,
    url: r.ghlLocationId ? ghlLocationUrl(r.ghlLocationId) : r.ghlSubaccountUrl,
    snapshotStatus: refreshed.get(r.id) ?? r.ghlSnapshotStatus,
    at: r.ghlProvisionedAt?.toISOString() ?? null,
  }))
  return [...(await recentClientsNeverProvisioned()), ...attempted]
}

const NEVER_PROVISIONED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Recent onboarding clients the automation skipped without recording an
 * attempt, so they would otherwise never show up here or get a button.
 */
async function recentClientsNeverProvisioned(): Promise<GhlProvisionRow[]> {
  const [settings, clients] = await Promise.all([
    getGhlSubaccountSettings(),
    prisma.client.findMany({
      where: {
        archivedAt: null,
        ghlLocationId: null,
        ghlProvisionStatus: null,
        ghlSubaccountUrl: null,
        intakes: { some: { receivedAt: { gte: new Date(Date.now() - NEVER_PROVISIONED_WINDOW_MS) } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true, name: true, createdAt: true,
        intakes: { orderBy: { receivedAt: 'asc' }, take: 1, select: { receivedAt: true } },
      },
    }),
  ])
  const since = Date.parse(settings.since)
  return clients.map((c) => {
    const first = c.intakes[0]?.receivedAt ?? c.createdAt
    // A client created from its submission is stamped with the submission's time.
    const onFileFirst = c.createdAt.getTime() < first.getTime() - 60_000
    const why = onFileFirst
      ? 'Not created: the submission was linked to a client already on file, and only new clients get one automatically.'
      : first.getTime() < since
        ? `Not created: submitted ${first.toLocaleString('en-US', { timeZone: 'America/New_York' })} ET, before the automation went live.`
        : !settings.enabled
          ? 'Not created: the automation is switched off.'
          : 'Not created automatically.'
    return {
      clientId: c.id,
      clientName: c.name,
      status: 'not started',
      error: `${why} Press Create to make it now.`,
      locationId: null,
      url: null,
      snapshotStatus: null,
      at: first.toISOString(),
    }
  })
}

// -------------------------------------------------------------------------
// By hand: the copy-and-paste board, and linking what a person created
// -------------------------------------------------------------------------

/**
 * GHL only lets sub-accounts be created by API on the Agency Pro plan, so
 * on Agency Unlimited a person creates it in GHL. The board shows them
 * exactly what the automation would have sent (same name, same fields,
 * same snapshot); once it exists, the Hub finds it by that name and links
 * it, or links a sub-account they paste the link of.
 */
export type GhlBoardField = { key: string; label: string; value: string; note?: string }

export type GhlSubAccountBoard = {
  client: { id: string; name: string; hasIntake: boolean }
  status: {
    locationId: string | null
    url: string | null
    provisionStatus: string | null
    provisionError: string | null
    snapshotStatus: string | null
  }
  /** In the order GHL's "create sub-account" form asks for them. */
  fields: GhlBoardField[]
  owner: GhlBoardField[]
  snapshot: { id: string; name: string | null; listed: boolean | null }
}

const BOARD_FIELDS: Array<[keyof CreateLocationInput, string, string?]> = [
  ['name', 'Sub-account name', 'Exactly this — the Hub links it by this name.'],
  ['phone', 'Business phone'],
  ['address', 'Street address'],
  ['city', 'City'],
  ['state', 'State'],
  ['postalCode', 'Postal code'],
  ['country', 'Country'],
  ['timezone', 'Time zone'],
  ['website', 'Website'],
]

export async function ghlSubAccountBoard(clientId: string): Promise<GhlSubAccountBoard | null> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true, name: true, contactName: true, contactEmail: true, contactPhone: true, address: true, website: true,
      ghlLocationId: true, ghlSubaccountUrl: true, ghlProvisionStatus: true, ghlProvisionError: true, ghlSnapshotStatus: true,
      intakes: {
        orderBy: { receivedAt: 'desc' },
        take: 1,
        select: { fullName: true, leadEmail: true, customerPhone: true, businessAddress: true, website: true, timeZone: true },
      },
    },
  })
  if (!client) return null
  const intake = client.intakes[0] ?? null
  const settings = await getGhlSubaccountSettings()
  const input = buildLocationInput(client, intake, settings.snapshotId)

  let snapshotName: string | null = null
  let listed: boolean | null = null
  try {
    const ctx = await getAgencyContext()
    const match = (await listSnapshots(ctx)).find((s) => s.id === settings.snapshotId)
    listed = !!match
    snapshotName = match?.name ?? null
  } catch {
    // The board still works without the agency key; the snapshot id is shown either way.
  }

  const email = client.contactEmail ?? intake?.leadEmail ?? ''
  return {
    client: { id: client.id, name: client.name, hasIntake: !!intake },
    status: {
      locationId: client.ghlLocationId,
      url: client.ghlLocationId ? ghlLocationUrl(client.ghlLocationId) : client.ghlSubaccountUrl,
      provisionStatus: client.ghlProvisionStatus,
      provisionError: client.ghlProvisionError,
      snapshotStatus: client.ghlSnapshotStatus,
    },
    fields: BOARD_FIELDS.map(([key, label, note]) => {
      const v = input[key]
      return { key, label, value: typeof v === 'string' ? v : '', ...(note ? { note } : {}) }
    }),
    owner: [
      { key: 'firstName', label: 'First name', value: input.prospectInfo?.firstName ?? firstNameOf(client.contactName ?? intake?.fullName) ?? '' },
      { key: 'lastName', label: 'Last name', value: input.prospectInfo?.lastName ?? lastNameOf(client.contactName ?? intake?.fullName) ?? '' },
      { key: 'email', label: 'Email', value: email },
    ],
    snapshot: { id: settings.snapshotId, name: snapshotName, listed },
  }
}

export type LinkResult =
  | { ok: true; status: 'linked' | 'already'; locationId: string; name: string }
  | { ok: false; status: 'not_found' | 'failed'; reason: string; expectedName?: string }

/** The id in a GHL sub-account link (…/v2/location/<id>/… or …/location/<id>), or the bare id. */
export function parseLocationId(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  const fromUrl = /\/location\/([A-Za-z0-9]{10,})/.exec(s)?.[1]
  if (fromUrl) return fromUrl
  return /^[A-Za-z0-9]{10,}$/.test(s) ? s : null
}

/**
 * Link a sub-account a person created in GHL: by the exact name the
 * board showed, or by a pasted link/id. Never creates anything.
 */
export async function linkGhlSubAccount(clientId: string, opts: { locationId?: string | null } = {}): Promise<LinkResult> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true, name: true, contactName: true, ghlLocationId: true, ghlSubaccountUrl: true,
      intakes: { orderBy: { receivedAt: 'desc' }, take: 1, select: { fullName: true } },
    },
  })
  if (!client) return { ok: false, status: 'failed', reason: 'client not found' }
  if (client.ghlLocationId) return { ok: true, status: 'already', locationId: client.ghlLocationId, name: client.name }

  const expectedName = subAccountName(client.contactName ?? client.intakes[0]?.fullName ?? null, client.name)
  try {
    const ctx = await getAgencyContext()
    let found: { id: string; name: string } | undefined
    if (opts.locationId) {
      const id = parseLocationId(opts.locationId)
      if (!id) return { ok: false, status: 'failed', reason: 'That doesn’t look like a GHL sub-account link or id.', expectedName }
      const loc = await getLocation(ctx, id)
      if (!loc) return { ok: false, status: 'not_found', reason: `GHL has no sub-account ${id} in this agency.`, expectedName }
      found = loc
    } else {
      const { locations } = await listAllLocations(ctx)
      found = locations.find((l) => normalizeName(l.name) === normalizeName(expectedName))
      if (!found) {
        return {
          ok: false,
          status: 'not_found',
          reason: `No sub-account named “${expectedName}” yet. Create it in GHL with that exact name, or paste its link.`,
          expectedName,
        }
      }
    }
    await prisma.client.update({
      where: { id: client.id },
      data: {
        ghlLocationId: found.id,
        ghlProvisionStatus: 'linked',
        ghlProvisionError: null,
        ghlProvisionedAt: new Date(),
        ...(client.ghlSubaccountUrl ? {} : { ghlSubaccountUrl: ghlLocationUrl(found.id) }),
      },
    })
    await hubAlert(
      `:link: *GHL sub-account linked* — *${found.name || expectedName}* was created in GHL by hand and is now on the client. <${ghlLocationUrl(found.id)}|Open in GHL> · <${hubLink(`/clients?focus=${client.id}`)}|Open client>`,
    )
    return { ok: true, status: 'linked', locationId: found.id, name: found.name || expectedName }
  } catch (err) {
    return { ok: false, status: 'failed', reason: describe(err), expectedName }
  }
}

