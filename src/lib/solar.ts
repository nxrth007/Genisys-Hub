/**
 * Google Solar API integration ("Project Sunroof" productized).
 *
 * Mary uses this mid-call to pre-qualify a customer's roof for solar:
 * is the house viable? How many panels would fit? What's the annual
 * sunshine? Saves a wasted appointment when the answer is "shaded
 * north-facing roof, not worth it."
 *
 * Two-step lookup:
 *   1. Geocode the address → lat/lng (free, via OSM/Nominatim)
 *   2. Call Google Solar API's buildingInsights:findClosest with
 *      that lat/lng → returns roof segments, panel layout, sunshine
 *      hours, energy production estimates.
 *
 * Aggressive caching by normalized address. Each cache row IS a
 * billable API call; cache hits cost zero. Solar imagery refreshes
 * yearly at most, so rows live forever by default — admins can
 * delete them via SQL or the future cache-management UI if Google
 * ships better data and they want a fresh fetch.
 */

import { prisma } from './prisma'
import { getSecretByName } from './vault-service'
import { normalizeAddress } from './address'

const VAULT_KEY_NAME = 'Google Maps Key'

/** Solar API base URL. v1 is the GA endpoint as of 2024. */
const SOLAR_API_BASE = 'https://solar.googleapis.com/v1'

/* -------------------------------------------------------------------------- */
/*  Public types — slim, friendly summary the UI consumes                      */
/* -------------------------------------------------------------------------- */

/** What the UI ultimately renders. The Solar API response is huge
 *  (full 3D roof segments, hourly shade maps, dozens of panel layout
 *  options); we boil it down to the handful of numbers Mary actually
 *  reads aloud during a call. */
export type SolarSummary = {
  /** Caller-friendly viability label derived from imagery quality +
   *  data presence. "Excellent" / "Good" / "Limited" / "Unavailable". */
  viability: 'excellent' | 'good' | 'limited' | 'unavailable'
  /** Imagery quality bucket from Google. */
  imageryQuality: 'HIGH' | 'MEDIUM' | 'LOW' | null
  /** Date Google's imagery was captured (year-month-day). Useful
   *  context — older imagery may misrepresent recent additions. */
  imageryCapturedAt: string | null
  /** Total roof area available for panels, in square meters. */
  roofAreaM2: number | null
  /** Yearly sunshine hours on the optimal panel placement. */
  maxSunshineHoursPerYear: number | null
  /** Most panels Google's layout solver fits on the roof. */
  maxPanelCount: number | null
  /** Annual energy production at the recommended panel count, kWh. */
  recommendedAnnualKwh: number | null
  /** Panel count behind recommendedAnnualKwh — usually different
   *  from maxPanelCount because of inverter sizing constraints. */
  recommendedPanelCount: number | null
  /** Lat/lng we resolved the address to. Surfaced so the UI can
   *  show "Here's the building Google looked at" alongside the map. */
  latitude: number | null
  longitude: number | null
  /** True when this came from cache (no upstream API call billed). */
  fromCache: boolean
}

/* -------------------------------------------------------------------------- */
/*  Main entry point                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Resolve solar potential for an address. Returns a SolarSummary on
 * success; throws with a user-friendly message on failure. The
 * `cached` flag tells the caller whether this was free or billable.
 */
export async function getSolarInsights(
  rawAddress: string
): Promise<SolarSummary> {
  const cleaned = normalizeAddress(rawAddress)?.trim()
  if (!cleaned) {
    throw new Error('Address is required.')
  }
  const addressKey = cleaned.toLowerCase()

  // Check cache first — saves a real API call (and therefore a
  // billable charge) when Mary checks the same property twice.
  const existing = await prisma.solarInsightsCache.findUnique({
    where: { addressKey },
  })
  if (existing) {
    return summarize(existing.payload, {
      latitude: existing.latitude,
      longitude: existing.longitude,
      imageryQuality:
        existing.imageryQuality === 'HIGH' ||
        existing.imageryQuality === 'MEDIUM' ||
        existing.imageryQuality === 'LOW'
          ? existing.imageryQuality
          : null,
      fromCache: true,
    })
  }

  // Cache miss — geocode then call Solar. Pull the API key once and
  // hand it to both calls so we don't re-read the vault.
  const apiKey = await getSecretByName(VAULT_KEY_NAME)
  const geo = await geocodeAddress(cleaned, apiKey)

  const url = new URL(`${SOLAR_API_BASE}/buildingInsights:findClosest`)
  url.searchParams.set('location.latitude', String(geo.latitude))
  url.searchParams.set('location.longitude', String(geo.longitude))
  // Default requiredQuality keeps low-confidence imagery out of the
  // result. Setting MEDIUM lets us still answer "no good data here"
  // for properties with only LOW imagery, instead of returning a
  // misleading premium-quality answer for a roof that wasn't really
  // imaged. Tunable later if it's too strict.
  url.searchParams.set('requiredQuality', 'MEDIUM')
  url.searchParams.set('key', apiKey)

  const res = await fetch(url.toString(), {
    method: 'GET',
    // Solar API doesn't need any auth headers — key is in the
    // query string. We intentionally don't follow redirects, since
    // a non-200 from Google should surface as an error.
    redirect: 'manual',
  })

  if (!res.ok) {
    // Google returns structured errors as JSON.
    let message = `Solar API responded ${res.status}`
    try {
      const data = (await res.json()) as { error?: { message?: string } }
      if (data.error?.message) message = data.error.message
    } catch {
      // Non-JSON error body — keep generic message.
    }
    throw new Error(message)
  }

  const payload = (await res.json()) as Record<string, unknown>

  // Persist before returning. We use upsert defensively in case two
  // concurrent requests race for the same address — second writer
  // collapses into an update with the same payload.
  await prisma.solarInsightsCache.upsert({
    where: { addressKey },
    create: {
      addressKey,
      rawAddress: cleaned,
      latitude: geo.latitude,
      longitude: geo.longitude,
      imageryQuality: stringField(payload, 'imageryQuality'),
      payload: payload as object,
    },
    update: {
      rawAddress: cleaned,
      latitude: geo.latitude,
      longitude: geo.longitude,
      imageryQuality: stringField(payload, 'imageryQuality'),
      payload: payload as object,
    },
  })

  return summarize(payload, {
    latitude: geo.latitude,
    longitude: geo.longitude,
    imageryQuality:
      stringField(payload, 'imageryQuality') as SolarSummary['imageryQuality'],
    fromCache: false,
  })
}

/* -------------------------------------------------------------------------- */
/*  Geocoding (Google Geocoding API)                                           */
/* -------------------------------------------------------------------------- */

/**
 * Resolve an address string to lat/lng using Google's Geocoding API.
 *
 * Originally tried OSM/Nominatim's free endpoint to keep this cost-
 * free, but their public service caps at 1 request/second per IP.
 * Render's outbound IP is shared with other deployments and hits
 * the limit unpredictably, surfacing as a confusing 429 mid-call.
 * Switching to Google's paid endpoint:
 *   - Same Cloud project + same vault key as the rest of Maps stack
 *   - $0.005 per call, with caching nearly all repeat lookups are
 *     free — at Mary's volume, a few dollars/month at most
 *   - Reliable + accurate; matches Google's view of the building,
 *     which gives Solar API's findClosest a tighter target
 *
 * Requires the **Geocoding API** enabled on the Cloud project.
 * That's a separate enable from Maps Embed and Solar — easy to
 * miss, so we surface a specific error message when Google
 * responds with REQUEST_DENIED so the admin knows what to fix.
 */
async function geocodeAddress(
  address: string,
  apiKey: string
): Promise<{ latitude: number; longitude: number }> {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json')
  url.searchParams.set('address', address)
  url.searchParams.set('region', 'us') // bias to US; Genisys is US-only
  url.searchParams.set('key', apiKey)
  const res = await fetch(url.toString(), {
    method: 'GET',
    redirect: 'manual',
  })
  if (!res.ok) {
    throw new Error(`Couldn't resolve the address (geocoder ${res.status}).`)
  }
  const data = (await res.json()) as {
    status?: string
    error_message?: string
    results?: Array<{
      geometry?: { location?: { lat?: number; lng?: number } }
    }>
  }
  if (data.status === 'OK' && data.results && data.results.length > 0) {
    const loc = data.results[0].geometry?.location
    if (
      loc &&
      typeof loc.lat === 'number' &&
      typeof loc.lng === 'number' &&
      Number.isFinite(loc.lat) &&
      Number.isFinite(loc.lng)
    ) {
      return { latitude: loc.lat, longitude: loc.lng }
    }
    throw new Error('Geocoder returned invalid coordinates for that address.')
  }
  // Surface the specific Google failure so admins can tell whether
  // it's a config problem, a quota issue, or genuinely an unknown
  // address. ZERO_RESULTS = address typed didn't match anywhere.
  if (data.status === 'ZERO_RESULTS') {
    throw new Error(
      "Couldn't find that address — double-check the street, city, and state.",
    )
  }
  if (data.status === 'REQUEST_DENIED') {
    throw new Error(
      'Geocoding API is not enabled on this project, or the vault key isn\'t allowed to call it. Enable "Geocoding API" in Google Cloud Console and confirm the API key restrictions allow it.',
    )
  }
  if (data.status === 'OVER_QUERY_LIMIT') {
    throw new Error(
      'Geocoder quota hit — check your Google Cloud billing + budget settings.',
    )
  }
  throw new Error(
    `Couldn't resolve the address (${data.status ?? 'unknown'}${data.error_message ? `: ${data.error_message}` : ''}).`,
  )
}

/* -------------------------------------------------------------------------- */
/*  Response → friendly summary                                                */
/* -------------------------------------------------------------------------- */

function summarize(
  payload: unknown,
  ctx: {
    latitude: number | null
    longitude: number | null
    imageryQuality: SolarSummary['imageryQuality']
    fromCache: boolean
  }
): SolarSummary {
  const p = payload as {
    solarPotential?: {
      maxArrayPanelsCount?: number
      maxArrayAreaMeters2?: number
      maxSunshineHoursPerYear?: number
      wholeRoofStats?: { areaMeters2?: number }
      solarPanelConfigs?: Array<{
        panelsCount?: number
        yearlyEnergyDcKwh?: number
      }>
    }
    imageryDate?: { year?: number; month?: number; day?: number }
  }
  const sp = p.solarPotential ?? {}
  const configs = sp.solarPanelConfigs ?? []
  // Pick the "recommended" config — middle of the road in terms of
  // panel count. Google sorts the configs by panel count ascending,
  // so the median config is the typical "good fit" recommendation
  // (max panels often overshoots inverter capacity).
  const recommended = configs.length > 0
    ? configs[Math.floor(configs.length / 2)]
    : null

  const imageryCapturedAt = p.imageryDate?.year
    ? `${p.imageryDate.year}-${String(p.imageryDate.month ?? 1).padStart(2, '0')}-${String(p.imageryDate.day ?? 1).padStart(2, '0')}`
    : null

  // Viability is a roll-up so the UI can lead with one word. Maps
  // Google's imageryQuality + presence of solar data to a friendly
  // label: HIGH imagery + good sunshine → excellent; MEDIUM imagery
  // → good; LOW or no panel configs → limited; absent altogether →
  // unavailable (e.g. rural areas Google hasn't imaged).
  let viability: SolarSummary['viability'] = 'unavailable'
  const sunshine = sp.maxSunshineHoursPerYear
  if (configs.length > 0 && sunshine && sunshine > 0) {
    if (ctx.imageryQuality === 'HIGH' && sunshine >= 1800) viability = 'excellent'
    else if (ctx.imageryQuality === 'HIGH' || ctx.imageryQuality === 'MEDIUM') viability = 'good'
    else viability = 'limited'
  }

  return {
    viability,
    imageryQuality: ctx.imageryQuality,
    imageryCapturedAt,
    roofAreaM2: sp.wholeRoofStats?.areaMeters2 ?? null,
    maxSunshineHoursPerYear: sunshine ?? null,
    maxPanelCount: sp.maxArrayPanelsCount ?? null,
    recommendedAnnualKwh: recommended?.yearlyEnergyDcKwh ?? null,
    recommendedPanelCount: recommended?.panelsCount ?? null,
    latitude: ctx.latitude,
    longitude: ctx.longitude,
    fromCache: ctx.fromCache,
  }
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key]
  return typeof v === 'string' ? v : null
}

/* -------------------------------------------------------------------------- */
/*  Usage stats — for the Settings counter                                     */
/* -------------------------------------------------------------------------- */

/**
 * How many billable Solar API calls have been made this calendar
 * month. Equal to the count of cache rows whose createdAt falls in
 * this month — every cache row corresponds to exactly one upstream
 * API call (cache hits never insert).
 */
export async function getSolarApiCallsThisMonth(): Promise<{
  calls: number
  cachedTotal: number
}> {
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const [calls, cachedTotal] = await Promise.all([
    prisma.solarInsightsCache.count({
      where: { createdAt: { gte: monthStart } },
    }),
    prisma.solarInsightsCache.count(),
  ])
  return { calls, cachedTotal }
}
