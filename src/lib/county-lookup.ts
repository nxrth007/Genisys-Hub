import { prisma } from './prisma'
import { getSecretByName } from './vault-service'

/**
 * County resolution for the master-tracker "County" column. Reuses the
 * same Google Geocoding API + vault key as the Solar feature, pulling
 * the administrative_area_level_2 component out of the address. The
 * resolved county is cached on Appointment.county (geocoded once at
 * booking + on address edits), so the master tracker reads it straight
 * from the DB — no geocoding on render.
 */

const VAULT_KEY_NAME = 'Google Maps Key'

type GeocodeComponent = {
  long_name?: string
  short_name?: string
  types?: string[]
}

/**
 * Resolve the county for a US street address via Google Geocoding.
 * Returns the bare county name ("Maricopa", not "Maricopa County") to
 * match the client intake's serviced-counties field, or null when the
 * address can't be resolved / carries no county component. Never
 * throws — callers fire-and-forget it.
 */
export async function lookupCountyForAddress(
  address: string | null | undefined,
): Promise<string | null> {
  const cleaned = (address ?? '').trim()
  if (!cleaned) return null

  let apiKey: string | null = null
  try {
    apiKey = await getSecretByName(VAULT_KEY_NAME)
  } catch {
    return null
  }
  if (!apiKey) return null

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
    if (!res.ok) return null
    data = await res.json()
  } catch {
    return null
  }
  if (data.status !== 'OK' || !data.results?.length) return null

  const comps = data.results[0].address_components ?? []
  const countyComp = comps.find((c) =>
    c.types?.includes('administrative_area_level_2'),
  )
  const raw = countyComp?.long_name?.trim()
  if (!raw) return null

  // Strip the trailing "County" / "Parish" / "Borough" so the column
  // reads "Maricopa", not "Maricopa County".
  return (
    raw.replace(/\s+(County|Parish|Borough|Census Area)$/i, '').trim() || null
  )
}

/**
 * Geocode an appointment's address → county and persist it on
 * Appointment.county. No-op when the appointment has no address or the
 * geocoder can't resolve one (so a transient blip never wipes an
 * existing value). Idempotent + safe to fire-and-forget.
 */
export async function fillCountyForAppointment(
  appointmentId: string,
): Promise<void> {
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: { id: true, address: true },
  })
  if (!appt?.address?.trim()) return
  const county = await lookupCountyForAddress(appt.address)
  if (!county) return
  await prisma.appointment.update({
    where: { id: appt.id },
    data: { county },
  })
}
