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
const AUTOMATION_LIVE_AT = '2026-10-11T00:00:00.000Z'

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
): Promise<ProvisionResult> {
  try {
    const settings = await getGhlSubaccountSettings()
    if (!settings.enabled) return { ok: false, status: 'skipped', reason: 'automation is off' }
    if (receivedAt.getTime() < Date.parse(settings.since)) {
      return { ok: false, status: 'skipped', reason: 'submission is from before the automation was switched on' }
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

  return rows.map((r) => ({
    clientId: r.id,
    clientName: r.name,
    status: r.ghlProvisionStatus ?? 'unknown',
    error: r.ghlProvisionError,
    locationId: r.ghlLocationId,
    url: r.ghlLocationId ? ghlLocationUrl(r.ghlLocationId) : r.ghlSubaccountUrl,
    snapshotStatus: refreshed.get(r.id) ?? r.ghlSnapshotStatus,
    at: r.ghlProvisionedAt?.toISOString() ?? null,
  }))
}
