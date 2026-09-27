import { prisma } from './prisma'
import { getSecretByName } from './vault-service'
import { STATE_NAME_TO_CODE } from './address'

/**
 * Put a client on the map.
 *
 * Google's Geocoding API when the Vault holds "Google Maps Key" and that
 * key has the Geocoding API enabled; OpenStreetMap's Nominatim otherwise.
 * A hit is stored on the Client, so each business is looked up once.
 *
 * Outcomes are kept apart on purpose. A hit stores coordinates. A
 * definitive miss (the geocoder answered "no such place") waits a week
 * before trying again. Anything transient — a timeout, a 429, a 5xx, a
 * quota error — retries within the hour instead of being mistaken for
 * "not found".
 */

export type GeoPoint = { lat: number; lng: number; label: string }
type Attempt = { point: GeoPoint | null; definitive: boolean }

const GOOGLE_KEY_ENTRY = 'Google Maps Key'
// Nominatim's usage policy: identify the application, at most 1 request/s.
const NOMINATIM_UA = 'GenisysHub/1.0 (+https://genisys-hub.onrender.com)'
const NOMINATIM_GAP_MS = 1100
const TIMEOUT_MS = 6000
const RETRY_NOT_FOUND_MS = 7 * 86400_000
const RETRY_ERROR_MS = 3600_000
/** How long a claim on a client lasts if the process dies mid-lookup. */
const LEASE_MS = 2 * 60_000

/** Clears every geo field — for when the address a point came from changes. */
export const GEO_RESET = {
  geoLat: null,
  geoLng: null,
  geoLabel: null,
  geoStatus: null,
  geoRetryAt: null,
  geocodedAt: null,
} as const

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function stateCode(name: string | null | undefined): string | null {
  const t = name?.trim()
  if (!t) return null
  if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase()
  return STATE_NAME_TO_CODE[t.toLowerCase()] ?? t
}

/** "City, ST" when both are known, else whatever the geocoder called it. */
function placeLabel(city: string | null | undefined, state: string | null | undefined, fallback: string) {
  const parts = [city?.trim() || null, stateCode(state)].filter(Boolean)
  return parts.length > 0 ? parts.join(', ') : fallback
}

type GoogleResult = {
  types?: string[]
  formatted_address?: string
  geometry?: { location?: { lat: number; lng: number } }
  address_components?: Array<{ long_name: string; short_name: string; types: string[] }>
}

/** null = Google is not available here (no key, or the key lacks the Geocoding API). */
async function viaGoogle(query: string): Promise<Attempt | null> {
  let key: string
  try {
    key = await getSecretByName(GOOGLE_KEY_ENTRY)
  } catch {
    return null
  }
  try {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json')
    url.searchParams.set('address', query)
    url.searchParams.set('region', 'us')
    url.searchParams.set('key', key)
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) return { point: null, definitive: false }
    const data = (await res.json()) as { status?: string; results?: GoogleResult[] }
    // A key without the Geocoding API enabled answers REQUEST_DENIED on
    // every call: configuration, not a transient failure — Nominatim decides.
    if (data.status === 'REQUEST_DENIED') return null
    if (data.status === 'ZERO_RESULTS') return { point: null, definitive: true }
    if (data.status !== 'OK') return { point: null, definitive: false }

    // A country-level result for a street or city query is a miss, not a hit.
    const hit = data.results?.find((r) =>
      (r.types ?? []).some((t) => t !== 'country' && t !== 'political'),
    )
    const loc = hit?.geometry?.location
    if (!hit || !loc) return { point: null, definitive: true }
    const part = (type: string) => hit.address_components?.find((c) => c.types.includes(type))
    const city =
      part('locality')?.long_name ??
      part('postal_town')?.long_name ??
      part('sublocality')?.long_name ??
      part('administrative_area_level_2')?.long_name
    const state = part('administrative_area_level_1')?.short_name
    return {
      point: { lat: loc.lat, lng: loc.lng, label: placeLabel(city, state, hit.formatted_address ?? query) },
      definitive: true,
    }
  } catch {
    return { point: null, definitive: false }
  }
}

// One Nominatim request per ~second for this whole process, however many
// callers (webhook, page loads, address edits) arrive at once.
let nominatimQueue: Promise<void> = Promise.resolve()
let lastNominatimAt = 0
function nominatimTurn(): Promise<void> {
  const turn = nominatimQueue.then(async () => {
    const wait = lastNominatimAt + NOMINATIM_GAP_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastNominatimAt = Date.now()
  })
  nominatimQueue = turn
  return turn
}

type NominatimHit = {
  lat: string
  lon: string
  display_name?: string
  address?: {
    city?: string
    town?: string
    village?: string
    hamlet?: string
    county?: string
    state?: string
  }
}

async function viaNominatim(query: string): Promise<Attempt> {
  await nominatimTurn()
  try {
    const url = new URL('https://nominatim.openstreetmap.org/search')
    url.searchParams.set('q', query)
    url.searchParams.set('format', 'jsonv2')
    url.searchParams.set('limit', '1')
    url.searchParams.set('countrycodes', 'us')
    url.searchParams.set('addressdetails', '1')
    const res = await fetch(url, {
      headers: { 'User-Agent': NOMINATIM_UA, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return { point: null, definitive: false }
    const data = (await res.json()) as NominatimHit[]
    const hit = data[0]
    if (!hit) return { point: null, definitive: true }
    const lat = Number(hit.lat)
    const lng = Number(hit.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { point: null, definitive: false }
    const a = hit.address ?? {}
    return {
      point: {
        lat,
        lng,
        label: placeLabel(a.city ?? a.town ?? a.village ?? a.hamlet ?? a.county, a.state, hit.display_name ?? query),
      },
      definitive: true,
    }
  } catch {
    return { point: null, definitive: false }
  }
}

/** A miss is definitive only if every geocoder that was asked said "no such place". */
export async function geocode(query: string): Promise<Attempt> {
  const q = query.trim()
  if (!q) return { point: null, definitive: true }
  const google = await viaGoogle(q)
  if (google?.point) return google
  const osm = await viaNominatim(q)
  if (osm.point) return osm
  return { point: null, definitive: osm.definitive && (google?.definitive ?? true) }
}

// A street address that names its state ("…, TX") or ends in a ZIP.
// Anchored so a five-digit house number doesn't pass for a ZIP.
const STATE_OR_ZIP = /,\s*[A-Za-z]{2}\b|\b[A-Za-z]{2}\s+\d{5}(?:-\d{4})?\b|\b\d{5}(?:-\d{4})?\s*$/

/** The first place in the form's free-text "cities served" answer. */
export function firstCity(cities: string | null | undefined): string | null {
  return (
    (cities ?? '')
      .split(/[,;\n/&]|\band\b/i)
      .map((c) => c.trim())
      .find((c) => c.length > 1) ?? null
  )
}

/**
 * What to ask the geocoder, best first. A street address that names its
 * state or ZIP stands alone; a bare street is only asked together with
 * the first city they serve (alone it matches that street in any town);
 * the city by itself is the fallback. City precision is plenty for a
 * globe — the whole US is about 150px across.
 */
export function clientGeoCandidates(input: {
  address: string | null | undefined
  cities: string | null | undefined
}): string[] {
  const address = input.address?.trim() || null
  const city = firstCity(input.cities)
  const out: string[] = []
  if (address && STATE_OR_ZIP.test(address)) out.push(address)
  else if (address && city) out.push(`${address}, ${city}`)
  if (city) out.push(city)
  return [...new Set(out)].map((q) => `${q}, USA`)
}

export type GeoOutcome = 'placed' | 'not-found' | 'error' | 'no-address' | 'skipped'

/**
 * Geocode one client that isn't on the map yet, and record the outcome.
 *
 * The client is claimed first, so the onboarding webhook, a Home load and
 * a second browser tab can't all look the same business up at once; only
 * a client that is unplaced and due for a (re)try can be claimed. The
 * final write is conditional on the claim still being ours, so an
 * address edit that lands mid-lookup wins over the stale result.
 */
export async function ensureClientGeo(clientId: string): Promise<GeoOutcome> {
  const now = new Date()
  const lease = new Date(now.getTime() + LEASE_MS)
  const claimed = await prisma.client.updateMany({
    where: {
      id: clientId,
      geoLat: null,
      OR: [{ geoRetryAt: null }, { geoRetryAt: { lte: now } }],
    },
    data: { geoRetryAt: lease },
  })
  if (claimed.count !== 1) return 'skipped'

  const finish = (data: {
    geoLat?: number
    geoLng?: number
    geoLabel?: string
    geoStatus: string
    geoRetryAt: Date | null
  }) =>
    prisma.client.updateMany({
      where: { id: clientId, geoRetryAt: lease },
      data: { ...data, geocodedAt: now },
    })

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      address: true,
      intakes: {
        orderBy: { receivedAt: 'desc' },
        take: 1,
        select: { businessAddress: true, cities: true },
      },
    },
  })
  const intake = client?.intakes[0]
  const candidates = clientGeoCandidates({
    address: client?.address ?? intake?.businessAddress,
    cities: intake?.cities,
  })
  if (candidates.length === 0) {
    await finish({ geoStatus: 'no-address', geoRetryAt: new Date(now.getTime() + RETRY_NOT_FOUND_MS) })
    return 'no-address'
  }

  let definitive = true
  for (const query of candidates) {
    const { point, definitive: sure } = await geocode(query)
    if (point) {
      await finish({
        geoLat: point.lat,
        geoLng: point.lng,
        geoLabel: point.label,
        geoStatus: 'placed',
        geoRetryAt: null,
      })
      return 'placed'
    }
    if (!sure) definitive = false
  }

  await finish({
    geoStatus: definitive ? 'not-found' : 'error',
    geoRetryAt: new Date(now.getTime() + (definitive ? RETRY_NOT_FOUND_MS : RETRY_ERROR_MS)),
  })
  return definitive ? 'not-found' : 'error'
}
