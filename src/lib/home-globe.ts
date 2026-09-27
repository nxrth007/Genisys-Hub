import { STATE_NAME_TO_CODE } from './address'

/**
 * Shared shape of what the Home globe draws.
 *
 * HQ is where arcs originate. Boston is a placeholder read off the
 * network edge this was built from — move it if the agency is
 * somewhere else; nothing else depends on it.
 */

export const HQ = { name: 'Genisys HQ', lat: 42.3601, lng: -71.0589 } as const

/** How long a site launch keeps its marker pulsing on the globe. */
export const LAUNCH_WINDOW_DAYS = 14

export type GlobeClientMarker = {
  id: string
  name: string
  lat: number
  lng: number
  /** "City, ST" when we can derive it from the geocoder's label. */
  place: string | null
  status: string
  siteUrl: string | null
  siteLiveAt: string | null
  onboardedAt: string
}

export type UnplacedReason = 'pending' | 'no-address' | 'not-found' | 'error'

export type GlobeData = {
  hq: typeof HQ
  markers: GlobeClientMarker[]
  /** Clients not on the map (yet), and why. `pending` resolves on its own. */
  unplaced: Array<{ id: string; name: string; reason: UnplacedReason }>
}

const ADMIN_AREA = /\b(County|Parish|Borough|Census Area|Municipality)$/i
const EXTRA_STATES: Record<string, string> = { 'district of columbia': 'DC' }
const COUNTRY = /^(usa|us|united states(?: of america)?)$/i
const ZIP_ONLY = /^\d{5}(-\d{4})?$/

/**
 * "New Braunfels, TX" from whatever label the geocoder stored — already
 * "City, ST" for new rows, but tolerant of a full Google address or a
 * Nominatim display name ("Ocala, Marion County, Florida, 34474, United
 * States"), skipping the county and the ZIP.
 */
export function placeFromLabel(label: string | null): string | null {
  if (!label) return null
  const kept = label
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p && !COUNTRY.test(p) && !ZIP_ONLY.test(p))
  // Drop a county only when a city is left to show; "Marion County, FL"
  // (no city found) keeps it rather than collapsing to just "FL".
  const withoutCounty = kept.filter((p) => !ADMIN_AREA.test(p))
  const parts = withoutCounty.length >= 2 ? withoutCounty : kept
  if (parts.length === 0) return null
  if (parts.length === 1) return parts[0]
  const rawState = parts[parts.length - 1].replace(/\s*\d{5}(-\d{4})?$/, '').trim()
  const state = STATE_NAME_TO_CODE[rawState.toLowerCase()] ?? EXTRA_STATES[rawState.toLowerCase()] ?? rawState
  const city = parts[parts.length - 2]
  return state ? `${city}, ${state}` : city
}
