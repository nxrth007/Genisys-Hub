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

export function browserFieldsFromLocation(
  input: LocationLike,
  extra: { email?: string | null; firstName?: string | null; lastName?: string | null; snapshotName?: string | null } = {},
): BrowserFields {
  const countryRaw = input.country?.trim() || 'US'
  const country = countryRaw === 'US' || countryRaw === 'USA' ? 'United States' : countryRaw
  return {
    name: input.name.trim(),
    email: (input.prospectInfo?.email || extra.email || '').trim(),
    phone: input.phone?.trim() || '',
    address: input.address?.trim() || '',
    city: input.city?.trim() || '',
    state: input.state?.trim() || '',
    postalCode: input.postalCode?.trim() || '',
    country,
    timezone: input.timezone?.trim() || '',
    website: input.website?.trim() || '',
    firstName: (input.prospectInfo?.firstName || extra.firstName || '').trim(),
    lastName: (input.prospectInfo?.lastName || extra.lastName || '').trim(),
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
