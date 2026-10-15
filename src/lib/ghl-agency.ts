/**
 * GoHighLevel agency-level API — creating sub-accounts and reading the
 * agency's snapshots. Everything in src/lib/ghl.ts works inside one
 * sub-account with that sub-account's token; this works across the
 * agency with the "GHL Agency Key" from the Vault.
 *
 * The agency calls need the agency (company) id alongside the key. A
 * Private Integration key ("pit-…") doesn't carry it, so it's found in
 * this order: GHL_COMPANY_ID, `companyId=…` in the Vault entry's
 * description, the key itself when it's a JWT, the agency's sub-account
 * list, and finally the company id inside any sub-account token in the
 * Vault (they all belong to the same agency).
 */
import { prisma } from './prisma'
import { getSecretByName, listEntriesByTag } from './vault-service'
import { API_VERSION, BASE_URL, GHL_AGENCY_KEY_VAULT_NAME, decodeJwtPayload } from './ghl'

export class GhlAgencyError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message)
    this.name = 'GhlAgencyError'
  }
}

/** GHL's error bodies carry `message` as a string or a list of validation messages. */
function errorMessage(status: number, text: string): string {
  try {
    const body = JSON.parse(text) as { message?: unknown; error?: unknown }
    const msg = Array.isArray(body.message) ? body.message.join('; ') : body.message
    if (typeof msg === 'string' && msg.trim()) return `GHL ${status}: ${msg.trim()}`
    if (typeof body.error === 'string' && body.error.trim()) return `GHL ${status}: ${body.error.trim()}`
  } catch {
    // Not JSON — fall through to the raw text.
  }
  return `GHL ${status}: ${text.slice(0, 300) || 'no response body'}`
}

async function agencyToken(): Promise<string> {
  return (await getSecretByName(GHL_AGENCY_KEY_VAULT_NAME)).trim()
}

async function agencyFetch<T = Record<string, unknown>>(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Version: API_VERSION,
        Accept: 'application/json',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    })
  } catch (err) {
    throw new GhlAgencyError(`Couldn't reach GHL: ${err instanceof Error ? err.message : String(err)}`, null)
  }
  const text = await res.text()
  if (!res.ok) throw new GhlAgencyError(errorMessage(res.status, text), res.status)
  try {
    return (text ? JSON.parse(text) : {}) as T
  } catch {
    throw new GhlAgencyError(`GHL ${res.status}: response wasn't JSON`, res.status)
  }
}

// -------------------------------------------------------------------------
// Agency context
// -------------------------------------------------------------------------

export type CompanyIdSource = 'env' | 'vault-description' | 'agency-key' | 'sub-account-list' | 'sub-account-token'

export type AgencyContext = {
  token: string
  companyId: string
  companyIdSource: CompanyIdSource
}

let cachedContext: { value: AgencyContext; expiresAt: number } | null = null
const CONTEXT_TTL_MS = 10 * 60 * 1000

async function companyIdFromDescription(): Promise<string | null> {
  const entry = await prisma.vaultEntry.findFirst({
    where: { name: GHL_AGENCY_KEY_VAULT_NAME },
    select: { description: true },
  })
  return entry?.description?.match(/company[_\s-]?id\s*[=:]\s*([A-Za-z0-9_-]+)/i)?.[1] ?? null
}

async function companyIdFromLocationList(token: string): Promise<string | null> {
  try {
    const res = await agencyFetch<{ locations?: Array<Record<string, unknown>> }>(token, '/locations/search?limit=1')
    const id = res.locations?.[0]?.companyId
    return typeof id === 'string' && id ? id : null
  } catch {
    return null
  }
}

/** The company id inside the Vault's sub-account tokens, when they all agree on one. */
async function companyIdFromSubAccountTokens(): Promise<string | null> {
  const entries = (await listEntriesByTag('ghl')).filter(
    (e) => e.name.trim().toLowerCase() !== GHL_AGENCY_KEY_VAULT_NAME.toLowerCase(),
  )
  const found = new Set<string>()
  for (const entry of entries) {
    try {
      const id = decodeJwtPayload(await getSecretByName(entry.name)).companyId
      if (id) found.add(id)
    } catch {
      // An unreadable entry just doesn't vote.
    }
  }
  return found.size === 1 ? [...found][0] : null
}

/** The agency key plus the agency id it acts for. Throws a readable error when either is missing. */
export async function getAgencyContext(opts: { fresh?: boolean } = {}): Promise<AgencyContext> {
  if (!opts.fresh && cachedContext && Date.now() < cachedContext.expiresAt) return cachedContext.value

  const token = await agencyToken()
  if (!token) throw new GhlAgencyError(`The Vault entry "${GHL_AGENCY_KEY_VAULT_NAME}" is empty.`, null)

  const tiers: Array<[CompanyIdSource, () => Promise<string | null>]> = [
    ['env', async () => process.env.GHL_COMPANY_ID?.trim() || null],
    ['vault-description', companyIdFromDescription],
    ['agency-key', async () => decodeJwtPayload(token).companyId],
    ['sub-account-list', () => companyIdFromLocationList(token)],
    ['sub-account-token', companyIdFromSubAccountTokens],
  ]
  for (const [source, find] of tiers) {
    const companyId = await find()
    if (companyId) {
      const value = { token, companyId, companyIdSource: source }
      cachedContext = { value, expiresAt: Date.now() + CONTEXT_TTL_MS }
      return value
    }
  }
  throw new GhlAgencyError(
    `Couldn't work out the GHL agency id for "${GHL_AGENCY_KEY_VAULT_NAME}". Add "companyId=<your agency id>" to that Vault entry's description (GHL → Agency Settings → Company → Company ID).`,
    null,
  )
}

// -------------------------------------------------------------------------
// Sub-accounts (locations)
// -------------------------------------------------------------------------

export type AgencyLocation = { id: string; name: string }

function toLocations(raw: unknown): AgencyLocation[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((l) => {
    const r = l as Record<string, unknown>
    const id = typeof r.id === 'string' ? r.id : typeof r._id === 'string' ? r._id : null
    return id ? [{ id, name: typeof r.name === 'string' ? r.name : '' }] : []
  })
}

/** One page of the agency's sub-accounts. `order: 'desc'` puts the newest first. */
export async function searchLocations(
  ctx: AgencyContext,
  opts: { skip?: number; limit?: number; order?: 'asc' | 'desc' } = {},
): Promise<AgencyLocation[]> {
  const qs = new URLSearchParams({
    companyId: ctx.companyId,
    skip: String(opts.skip ?? 0),
    limit: String(opts.limit ?? 100),
    order: opts.order ?? 'asc',
  })
  const res = await agencyFetch<{ locations?: unknown }>(ctx.token, `/locations/search?${qs}`)
  return toLocations(res.locations)
}

/** Every sub-account in the agency, up to `max`. `truncated` is true when there may be more. */
export async function listAllLocations(
  ctx: AgencyContext,
  max = 2000,
): Promise<{ locations: AgencyLocation[]; truncated: boolean }> {
  const pageSize = 100
  const all: AgencyLocation[] = []
  while (all.length < max) {
    const page = await searchLocations(ctx, { skip: all.length, limit: pageSize })
    all.push(...page)
    if (page.length < pageSize) return { locations: all, truncated: false }
  }
  return { locations: all, truncated: true }
}

export type CreateLocationInput = {
  name: string
  snapshotId: string
  phone?: string
  address?: string
  city?: string
  state?: string
  country?: string
  postalCode?: string
  website?: string
  timezone?: string
  prospectInfo?: { firstName: string; lastName: string; email: string }
}

/**
 * What a refusal from "create sub-account" means. GHL gates this one call
 * two ways the rest of the agency API isn't: the agency must be on the
 * Agency Pro ($497/mo) plan, and the key must be an agency-level Private
 * Integration with the "locations.write" scope. Listing snapshots and
 * sub-accounts works without either, so a 401/403 only here points at
 * one of these.
 */
export function explainCreateRefusal(err: GhlAgencyError): string {
  const planGate =
    'GHL only lets sub-accounts be created by API on the Agency Pro ($497/mo) plan — on Agency Unlimited ($297) this call is refused even with a valid key.'
  const keyGate =
    `The "${GHL_AGENCY_KEY_VAULT_NAME}" Vault entry must be an agency-level Private Integration (Agency Settings → Private Integrations, not one made inside a sub-account) with the "locations.write" scope ticked.`
  if (err.status === 403) return `${err.message}. ${planGate} ${keyGate}`
  if (err.status === 401) return `${err.message}. ${keyGate}`
  return err.message
}

/** Create a sub-account in the agency, loading `snapshotId` into it. */
export async function createLocation(ctx: AgencyContext, input: CreateLocationInput): Promise<AgencyLocation> {
  let res: Record<string, unknown>
  try {
    res = await agencyFetch<Record<string, unknown>>(ctx.token, '/locations/', {
      method: 'POST',
      body: { ...input, companyId: ctx.companyId },
    })
  } catch (err) {
    if (err instanceof GhlAgencyError && (err.status === 401 || err.status === 403)) {
      throw new GhlAgencyError(explainCreateRefusal(err), err.status)
    }
    throw err
  }
  const created = toLocations([isRecordWithId(res.location) ? res.location : res])[0]
  if (!created) throw new GhlAgencyError('GHL created the sub-account but its response had no id', null)
  return { id: created.id, name: created.name || input.name }
}

/**
 * Load `snapshotId` into an existing sub-account. With override off, GHL
 * only adds what the sub-account doesn't already have.
 */
export async function loadSnapshotIntoLocation(ctx: AgencyContext, locationId: string, snapshotId: string): Promise<void> {
  try {
    await agencyFetch(ctx.token, `/locations/${encodeURIComponent(locationId)}`, {
      method: 'PUT',
      body: { companyId: ctx.companyId, snapshot: { id: snapshotId, override: false } },
    })
  } catch (err) {
    if (err instanceof GhlAgencyError && (err.status === 401 || err.status === 403)) {
      throw new GhlAgencyError(
        `${err.message}. The "${GHL_AGENCY_KEY_VAULT_NAME}" Vault entry must be an agency-level Private Integration with the "locations.write" scope, and GHL may only allow this on the Agency Pro plan, as it does for creating sub-accounts.`,
        err.status,
      )
    }
    throw err
  }
}

/** One sub-account by id; null when GHL has no such location or it isn't this agency's. */
export async function getLocation(ctx: AgencyContext, locationId: string): Promise<(AgencyLocation & { companyId: string | null }) | null> {
  let res: { location?: Record<string, unknown> }
  try {
    res = await agencyFetch<{ location?: Record<string, unknown> }>(ctx.token, `/locations/${encodeURIComponent(locationId)}`)
  } catch (err) {
    if (err instanceof GhlAgencyError && (err.status === 404 || err.status === 403 || err.status === 422)) return null
    throw err
  }
  const loc = res.location
  if (!isRecordWithId(loc)) return null
  const companyId = typeof loc.companyId === 'string' ? loc.companyId : null
  if (companyId && companyId !== ctx.companyId) return null
  return { id: loc.id as string, name: typeof loc.name === 'string' ? loc.name : '', companyId }
}

function isRecordWithId(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>).id === 'string'
}

// -------------------------------------------------------------------------
// Snapshots
// -------------------------------------------------------------------------

export type AgencySnapshot = { id: string; name: string; type: string }

export async function listSnapshots(ctx: AgencyContext): Promise<AgencySnapshot[]> {
  const res = await agencyFetch<{ snapshots?: unknown }>(
    ctx.token,
    `/snapshots/?companyId=${encodeURIComponent(ctx.companyId)}`,
  )
  if (!Array.isArray(res.snapshots)) return []
  return res.snapshots.flatMap((s) => {
    const r = s as Record<string, unknown>
    return typeof r.id === 'string'
      ? [{ id: r.id, name: typeof r.name === 'string' ? r.name : '', type: typeof r.type === 'string' ? r.type : '' }]
      : []
  })
}

export type SnapshotPushStatus = { status: string; completed: string[]; pending: string[] }

/** How far GHL has got loading a snapshot into a sub-account; null when it has no record of it. */
export async function getSnapshotPushStatus(
  ctx: AgencyContext,
  snapshotId: string,
  locationId: string,
): Promise<SnapshotPushStatus | null> {
  const res = await agencyFetch<{ data?: Record<string, unknown> }>(
    ctx.token,
    `/snapshots/snapshot-status/${encodeURIComponent(snapshotId)}/location/${encodeURIComponent(locationId)}?companyId=${encodeURIComponent(ctx.companyId)}`,
  )
  const data = res.data
  if (!data || typeof data.status !== 'string') return null
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  return { status: data.status, completed: list(data.completed), pending: list(data.pending) }
}
