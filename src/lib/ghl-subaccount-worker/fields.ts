/**
 * What the create-sub-account form is filled with.
 *
 * Built from the same CreateLocationInput the API path would have sent
 * (src/lib/ghl-subaccount-provisioning.ts `buildLocationInput`), so the
 * name, phone, address and snapshot stay in lockstep with the by-hand
 * board. The browser types "United States" where the API sends "US".
 */
import type { ResolvedAddress } from '@/lib/address-parse'
import { timezoneForStateName } from '@/lib/timezone'

export type BrowserFields = {
  name: string
  email: string
  phone: string
  address: string
  city: string
  state: string
  postalCode: string
  country: string
  timezone: string
  website: string
  firstName: string
  lastName: string
  snapshotId: string
  snapshotName: string
}

export type LocationLike = {
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

const TEXT_KEYS = ['name', 'email', 'phone', 'address', 'city', 'state', 'postalCode', 'country', 'timezone', 'website', 'firstName', 'lastName', 'snapshotId', 'snapshotName'] as const

function tidy(value: string | null | undefined): string {
  return (value || '').trim().replace(/\s+/g, ' ')
}

/**
 * The GHL business-name field: "Brett: Wilson Construction".
 * A business name that already starts with "<first>:" is left as that name.
 * With no first name, the business name is used and `warning` says so.
 */
export function ghlSubAccountName(
  firstName: string | null | undefined,
  businessName: string | null | undefined,
): { name: string; warning: string | null } {
  const business = tidy(businessName)
  const first = tidy(firstName).replace(/[.,;:]+$/g, '')
  if (!first) {
    return {
      name: business,
      warning: business ? 'Contractor first name is missing, so the sub-account name is the business name only.' : null,
    }
  }
  const prefix = `${first}:`
  if (business.toLowerCase().startsWith(prefix.toLowerCase())) {
    const rest = business.slice(prefix.length).trim()
    return { name: rest ? `${first}: ${rest}` : business, warning: null }
  }
  return { name: `${first}: ${business}`, warning: null }
}

export function browserFieldsFromLocation(
  input: LocationLike,
  extra: { email?: string | null; firstName?: string | null; lastName?: string | null; snapshotName?: string | null } = {},
): BrowserFields {
  const countryRaw = input.country?.trim() || 'US'
  const country = countryRaw === 'US' || countryRaw === 'USA' ? 'United States' : countryRaw
  const firstName = tidy(input.prospectInfo?.firstName || extra.firstName)
  const lastName = tidy(input.prospectInfo?.lastName || extra.lastName)
  return {
    name: ghlSubAccountName(firstName, input.name).name,
    email: tidy(input.prospectInfo?.email || extra.email),
    phone: input.phone?.trim() || '',
    address: input.address?.trim() || '',
    city: input.city?.trim() || '',
    state: input.state?.trim() || '',
    postalCode: input.postalCode?.trim() || '',
    country,
    timezone: input.timezone?.trim() || '',
    website: input.website?.trim() || '',
    firstName,
    lastName,
    snapshotId: input.snapshotId.trim(),
    snapshotName: (extra.snapshotName || '').trim(),
  }
}

export function readBrowserFields(value: unknown): BrowserFields | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const r = value as Record<string, unknown>
  if (typeof r.name !== 'string' || !r.name.trim()) return null
  if (typeof r.snapshotId !== 'string') return null
  const out = {} as BrowserFields
  for (const key of TEXT_KEYS) {
    const v = r[key]
    out[key] = typeof v === 'string' ? v : ''
  }
  out.name = out.name.trim()
  return out
}

/**
 * GHL's Add Sub-Account form marks these required (seen 2026-11-12).
 * Country is always filled. Without one of these GHL closes the form and
 * creates nothing, without saying why.
 */
const REQUIRED_FOR_GHL: { key: keyof BrowserFields; label: string }[] = [
  { key: 'address', label: 'street address' },
  { key: 'city', label: 'city' },
  { key: 'postalCode', label: 'zip code' },
  { key: 'timezone', label: 'time zone' },
]

/** Plain-English names of the required fields that are empty. */
export function missingForGhlCreate(fields: BrowserFields): string[] {
  return REQUIRED_FOR_GHL.filter(({ key }) => !String(fields[key] || '').trim()).map(({ label }) => label)
}

/**
 * The address to look up when the zip, city or state is missing, or null.
 * Only an address that already names its city or state is looked up: a
 * bare street could match the wrong town anywhere in the country.
 */
export function addressGapQuery(fields: BrowserFields): string | null {
  const street = fields.address.trim()
  const city = fields.city.trim()
  const state = fields.state.trim()
  const zip = fields.postalCode.trim()
  if (!street || !(city || state)) return null
  if (zip && city && state) return null
  return [street, city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')
}

/**
 * Fill only the empty zip, city and state from the address lookup, then the
 * time zone from the state. What the client typed is never replaced, and a
 * lookup that lands in a different state is ignored.
 */
export function fillAddressGaps(fields: BrowserFields, found: ResolvedAddress | null): { fields: BrowserFields; filled: string[] } {
  if (!found) return { fields, filled: [] }
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
  const typedState = fields.state.trim()
  if (typedState && found.state && !same(typedState, found.state) && !same(typedState, found.stateName)) {
    return { fields, filled: [] }
  }
  const out: BrowserFields = { ...fields }
  const filled: string[] = []
  if (!out.postalCode.trim() && found.zip) {
    out.postalCode = found.zip
    filled.push(`zip code ${found.zip}`)
  }
  if (!out.city.trim() && found.city) {
    out.city = found.city
    filled.push(`city ${found.city}`)
  }
  if (!out.state.trim() && (found.stateName || found.state)) {
    out.state = found.stateName || found.state
    filled.push(`state ${out.state}`)
  }
  if (!out.timezone.trim() && out.state.trim()) {
    const zone = timezoneForStateName(out.state)
    if (zone) {
      out.timezone = zone
      filled.push(`time zone ${zone}`)
    }
  }
  return { fields: out, filled }
}

/** The dropdown text. The id is the fallback when the name was never resolved. */
export function snapshotChoice(fields: BrowserFields): string {
  return fields.snapshotName.trim() || fields.snapshotId.trim()
}

export type SnapshotChoice = {
  id: string
  name: string
  /** env_id beats a listed name, which beats Settings, which beats the queued payload. */
  source: 'env_id' | 'snapshot_name' | 'settings' | 'payload'
}

/**
 * The snapshot to load. A queued payload can keep an old id after Settings
 * or the env has moved on. The client kit is "Final Master Client Sub Acc
 * Snapshot" (pHagdFFJPsZBnn8ACSHK, My snapshots), the Settings default.
 */
export function resolveSnapshotChoice(input: {
  payloadId?: string | null
  payloadName?: string | null
  envId?: string | null
  envName?: string | null
  settingsId?: string | null
  listed?: { id: string; name: string }[] | null
}): SnapshotChoice {
  const listed = input.listed || []
  const byName = (name: string) => listed.find((item) => item.name.trim().toLowerCase() === name.trim().toLowerCase())
  const byId = (id: string) => listed.find((item) => item.id === id)
  const envId = input.envId?.trim() || ''
  if (envId) return { id: envId, name: byId(envId)?.name || input.envName?.trim() || input.payloadName?.trim() || '', source: 'env_id' }
  const envName = input.envName?.trim() || ''
  const named = envName ? byName(envName) : undefined
  if (named) return { id: named.id, name: named.name, source: 'snapshot_name' }
  const settingsId = input.settingsId?.trim() || ''
  if (settingsId) return { id: settingsId, name: byId(settingsId)?.name || input.envName?.trim() || input.payloadName?.trim() || '', source: 'settings' }
  return { id: input.payloadId?.trim() || '', name: input.payloadName?.trim() || '', source: 'payload' }
}

/** Last snapshot-push document from GET /snapshots/snapshot-status/:snapshotId/location/:locationId. */
export type SnapshotPushStatus = {
  id: string | null
  locationId: string | null
  status: string
  /** Asset type names the push document lists as finished. Not a count of records in the location. */
  completed: string[]
  pending: string[]
  failed: string[]
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export function readSnapshotPushStatus(data: unknown): SnapshotPushStatus | null {
  if (!data || typeof data !== 'object') return null
  const row = data as Record<string, unknown>
  if (typeof row.status !== 'string' || !row.status.trim()) return null
  return {
    id: typeof row.id === 'string' ? row.id : null,
    locationId: typeof row.locationId === 'string' ? row.locationId : null,
    status: row.status,
    completed: stringList(row.completed),
    pending: stringList(row.pending),
    failed: [...stringList(row.failed), ...stringList(row.errors)],
  }
}

/**
 * What the status call actually said. `completed` is a list of asset
 * types on the push document (funnels, workflow, …), not proof those
 * records exist in the location.
 */
export function describeSnapshotPush(status: SnapshotPushStatus | null, requestedLocationId: string, snapshotId: string): string {
  const endpoint = `GET /snapshots/snapshot-status/${snapshotId}/location/${requestedLocationId}`
  if (!status) {
    return `${endpoint} returned no snapshot-status record. That call is the last push for this snapshot and location, not the snapshot's own asset list.`
  }
  const where = !status.locationId
    ? 'The response has no locationId, so it was not checked against this location.'
    : status.locationId === requestedLocationId
      ? `The response locationId is ${status.locationId}.`
      : `The response locationId is ${status.locationId}, which is not ${requestedLocationId}.`
  const failed = status.failed.length ? `Failed items: ${status.failed.join(', ')}.` : 'No failed items in the response.'
  return [
    `${endpoint} is GHL's last snapshot push for that location.`,
    `Status "${status.status}".`,
    'completed and pending are asset type names on that push document, not a count of records that landed in the location.',
    `Completed types: ${status.completed.join(', ') || '(none)'}.`,
    `Pending types: ${status.pending.join(', ') || '(none)'}.`,
    failed,
    where,
    status.id ? `Document ${status.id}.` : '',
  ]
    .filter(Boolean)
    .join(' ')
}

/** How long a new sub-account may take to finish loading its snapshot. */
export const SNAPSHOT_WAIT_MS = 20 * 60 * 1000
/** How often the worker asks GHL for the load status while it waits. */
export const SNAPSHOT_POLL_MS = 60 * 1000
/** Creating with a snapshot starts the load at once. No status record after this long means it never started. */
export const SNAPSHOT_START_GRACE_MS = 5 * 60 * 1000

export type SnapshotWaitStep = { done: false; note: string } | { done: true; ok: boolean; note: string }

/**
 * One reading of GHL's load status for this snapshot on this location.
 * GHL's own "completed" is the success signal. A status record for some
 * other location counts as no record.
 */
export function snapshotWaitStep(input: {
  status: SnapshotPushStatus | null
  locationId: string
  snapshotLabel: string
  elapsedMs: number
  waitMs?: number
  startGraceMs?: number
}): SnapshotWaitStep {
  const waitMs = input.waitMs ?? SNAPSHOT_WAIT_MS
  const graceMs = input.startGraceMs ?? SNAPSHOT_START_GRACE_MS
  const minutes = Math.round(input.elapsedMs / 60_000)
  const status = input.status && (!input.status.locationId || input.status.locationId === input.locationId) ? input.status : null
  const state = snapshotImportState(status)
  const label = input.snapshotLabel
  const pending = status?.pending.length ? ` Still pending: ${status.pending.join(', ')}.` : ''
  const failedParts = status?.failed.length ? ` Failed parts: ${status.failed.join(', ')}.` : ''
  if (state === 'applied') {
    if (failedParts) {
      return { done: true, ok: false, note: `GHL finished loading ${label}, but some parts failed.${failedParts} Open the sub-account and check what is missing.` }
    }
    return { done: true, ok: true, note: `GHL finished loading ${label} into this sub-account.` }
  }
  if (state === 'failed') {
    return { done: true, ok: false, note: `GHL says loading ${label} failed (status "${status?.status}").${failedParts}` }
  }
  if (state === 'missing' && input.elapsedMs >= graceMs) {
    return { done: true, ok: false, note: `GHL never started loading ${label} into this sub-account. There was still no load status after ${minutes} minutes.` }
  }
  if (input.elapsedMs >= waitMs) {
    return { done: true, ok: false, note: `GHL was still loading ${label} after ${minutes} minutes (status "${status?.status ?? 'none'}").${pending}` }
  }
  if (state === 'missing') return { done: false, note: `Waiting for GHL to start loading ${label}.` }
  return { done: false, note: `GHL is loading ${label} (status "${status?.status}").${pending}` }
}

/**
 * `missing` means this snapshot was never started on the location.
 * A processing push can already list asset types under `completed`;
 * that list does not mean the push finished or that the location has those assets.
 */
export function snapshotImportState(status: { status: string; completed?: string[]; pending?: string[] } | null | undefined): 'applied' | 'loading' | 'missing' | 'failed' {
  if (!status || !status.status?.trim()) return 'missing'
  if (/fail|error/i.test(status.status)) return 'failed'
  if (/process|pend|load|import|queue|progress/i.test(status.status)) return 'loading'
  if (/complete|success|done|finish/i.test(status.status)) return 'applied'
  if ((status.pending || []).length > 0) return 'loading'
  return 'missing'
}
