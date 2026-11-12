/**
 * What the create-sub-account form is filled with.
 *
 * Built from the same CreateLocationInput the API path would have sent
 * (src/lib/ghl-subaccount-provisioning.ts `buildLocationInput`), so the
 * name, phone, address and snapshot stay in lockstep with the by-hand
 * board. The browser types "United States" where the API sends "US".
 */

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
 * or the snapshot name (Master Template) has moved on.
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

/** GHL's snapshot-status payload. `missing` means this snapshot was never started on the location. */
export function snapshotImportState(status: { status: string; completed?: string[]; pending?: string[] } | null | undefined): 'applied' | 'loading' | 'missing' | 'failed' {
  if (!status || !status.status?.trim()) return 'missing'
  if (/fail|error/i.test(status.status)) return 'failed'
  if (/complete|success|done|finish/i.test(status.status) || (status.completed || []).length > 0) return 'applied'
  if (/process|pend|load|import|queue|progress/i.test(status.status) || (status.pending || []).length > 0) return 'loading'
  return 'missing'
}
