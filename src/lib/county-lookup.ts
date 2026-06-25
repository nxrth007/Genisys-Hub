import { prisma } from './prisma'
import { getSecretByName } from './vault-service'

/**
 * County resolution for the master-tracker "County" column. Reuses the
 * same Google Geocoding API + vault key as the Solar feature, pulling
 * the administrative_area_level_2 component out of the address. The
 * resolved county is cached on Appointment.county (geocoded once at
 * booking + on address edits, and backfilled for existing rows), so
 * the master tracker reads it straight from the DB — no geocoding on
 * render.
 *
 * NOTHING in this file touches reminders, client alerts, or dispatch —
 * it only ever writes the `county` field.
 */

const VAULT_KEY_NAME = 'Google Maps Key'

type GeocodeComponent = {
  long_name?: string
  short_name?: string
  types?: string[]
}

/**
 * `ok` distinguishes a DEFINITIVE result (the geocoder responded and
 * this address genuinely has no county we can use → safe to stop
 * retrying) from a TRANSIENT failure (no key, quota, REQUEST_DENIED,
 * network blip → leave it for a later retry). This is what stops a
 * misconfigured key from permanently blanking every address.
 */
type CountyResult = { county: string | null; ok: boolean }

async function geocodeCounty(
  address: string | null | undefined,
): Promise<CountyResult> {
  const cleaned = (address ?? '').trim()
  if (!cleaned) return { county: null, ok: true } // no address = definitively none

  let apiKey: string | null = null
  try {
    apiKey = await getSecretByName(VAULT_KEY_NAME)
  } catch {
    return { county: null, ok: false }
  }
  if (!apiKey) return { county: null, ok: false }

  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json')
  url.searchParams.set('address', cleaned)
  url.searchParams.set('region', 'us') // bias to US; Genisys is US-only
  url.searchParams.set('key', apiKey)

  let data: {
    status?: string
    results?: Array<{ address_components?: GeocodeComponent[] }>
  }
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      redirect: 'manual',
    })
    if (!res.ok) return { county: null, ok: false }
    data = await res.json()
  } catch {
    return { county: null, ok: false }
  }

  if (data.status === 'OK' && data.results?.length) {
    const comps = data.results[0].address_components ?? []
    const countyComp = comps.find((c) =>
      c.types?.includes('administrative_area_level_2'),
    )
    const raw = countyComp?.long_name?.trim()
    const county = raw
      ? raw.replace(/\s+(County|Parish|Borough|Census Area)$/i, '').trim() ||
        null
      : null
    return { county, ok: true }
  }
  // Address didn't match anywhere → definitive, no county exists.
  if (data.status === 'ZERO_RESULTS') return { county: null, ok: true }
  // REQUEST_DENIED / OVER_QUERY_LIMIT / UNKNOWN_ERROR / etc. → transient
  // or config; don't mark the row "resolved", let it retry later.
  return { county: null, ok: false }
}

/**
 * Resolve the county for a US street address. Returns the bare county
 * name ("Maricopa", not "Maricopa County") or null. Never throws.
 */
export async function lookupCountyForAddress(
  address: string | null | undefined,
): Promise<string | null> {
  return (await geocodeCounty(address)).county
}

/**
 * Geocode one appointment's address → county and persist it. No-op when
 * the appointment has no address or the geocoder can't resolve one (so
 * a transient blip never wipes an existing value). Fire-and-forget from
 * the booking / edit flows.
 */
export async function fillCountyForAppointment(
  appointmentId: string,
): Promise<void> {
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: { id: true, address: true },
  })
  if (!appt?.address?.trim()) return
  const { county } = await geocodeCounty(appt.address)
  if (!county) return
  await prisma.appointment.update({
    where: { id: appt.id },
    data: { county },
  })
}

export type CountyBackfillResult = {
  scanned: number
  filled: number
  unresolved: number
  remaining: number
  /** Whole batch failed transiently — almost always a key/quota/API
   *  config problem worth surfacing rather than silently retrying. */
  likelyConfigError: boolean
}

/**
 * Fill county for up to `limit` appointments that have an address but
 * no county yet. Resolvable → real county. Definitively-no-county (bad
 * address / no admin level) → empty-string sentinel so it isn't retried
 * forever. Transient failures are left null to retry on a later pass.
 *
 * Only writes the `county` field. Shared by the scheduler (drains the
 * backlog automatically) and the admin backfill endpoint.
 */
export async function backfillMissingCounties(
  limit: number,
): Promise<CountyBackfillResult> {
  const where = { county: null, address: { not: null } } as const
  const remainingBefore = await prisma.appointment.count({ where })
  if (remainingBefore === 0) {
    return {
      scanned: 0,
      filled: 0,
      unresolved: 0,
      remaining: 0,
      likelyConfigError: false,
    }
  }

  const batch = await prisma.appointment.findMany({
    where,
    select: { id: true, address: true },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })

  let filled = 0
  let unresolved = 0
  let transient = 0
  for (const appt of batch) {
    const { county, ok } = await geocodeCounty(appt.address)
    if (county) {
      await prisma.appointment.update({
        where: { id: appt.id },
        data: { county },
      })
      filled++
    } else if (ok) {
      // Definitively no county for this address — sentinel so the
      // backfill doesn't keep re-geocoding it. Shows as "—" in the UI;
      // a later address edit re-fills it with the real value.
      await prisma.appointment.update({
        where: { id: appt.id },
        data: { county: '' },
      })
      unresolved++
    } else {
      transient++ // leave null, retry next pass
    }
  }

  return {
    scanned: batch.length,
    filled,
    unresolved,
    // Transient rows stay null, so they're still "remaining".
    remaining: Math.max(0, remainingBefore - filled - unresolved),
    likelyConfigError: batch.length > 0 && transient === batch.length,
  }
}
