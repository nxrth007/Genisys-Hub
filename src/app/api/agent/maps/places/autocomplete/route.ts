import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { getSecretByName } from '@/lib/vault-service'

/**
 * GET /api/agent/maps/places/autocomplete?q=...
 *
 * Server-side proxy for Google Places Autocomplete. Pulls the API
 * key from the vault on every request (no env var, no bundle leak)
 * and forwards the query to Google. Same pattern as
 * /api/agent/maps/embed-url and /api/agent/solar/insights.
 *
 * Used by the appointment form's address autocomplete to give Mary
 * faster + more accurate suggestions than the OpenStreetMap
 * Nominatim fallback.
 *
 * Returns:
 *   200 { predictions: [{ description, placeId }] }
 *     description = "1141 Pleasant Hill Rd, Leander, TX, USA"
 *     placeId     = "ChIJ..." (kept around for future Place Details
 *                    upgrade — not needed for the current
 *                    description-only flow)
 *   400 — q missing
 *   503 { error } — vault key missing; client falls back to Nominatim
 *   502 { error } — Google replied with a non-OK status
 *
 * Filters: country=US (every Genisys client is US), types=address
 * (suppresses business-name predictions that aren't useful for a
 * customer's home).
 */
const VAULT_KEY_NAME = 'Google Maps Key'

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  if (!q) {
    return NextResponse.json({ error: 'q is required' }, { status: 400 })
  }

  let key: string
  try {
    key = await getSecretByName(VAULT_KEY_NAME)
  } catch {
    return NextResponse.json(
      {
        error: `Add a vault entry named "${VAULT_KEY_NAME}" to enable Google Places autocomplete (the form falls back to OpenStreetMap until then).`,
      },
      { status: 503 },
    )
  }

  // Legacy Place Autocomplete API — well-supported, simpler response
  // shape than the v1 New API. Field selection is implicit (we only
  // read description + place_id below). If we ever need lat/lng or
  // utc_offset_minutes, add a follow-up Place Details call keyed on
  // place_id.
  const url = new URL(
    'https://maps.googleapis.com/maps/api/place/autocomplete/json',
  )
  url.searchParams.set('key', key)
  url.searchParams.set('types', 'address')
  url.searchParams.set('components', 'country:us')

  // Optional state bias. The legacy Places Autocomplete API only
  // supports country filters in `components` — passing
  // `administrative_area:CA` returns INVALID_REQUEST. So instead of
  // filtering server-side, we append the state code to the search
  // text and let Google's NLP bias naturally toward that area. Same
  // result for the user; works with the existing endpoint.
  const stateBias = (req.nextUrl.searchParams.get('state') ?? '')
    .trim()
    .toUpperCase()
  const isValidStateBias = /^[A-Z]{2}$/.test(stateBias)
  const alreadyMentionsState =
    isValidStateBias &&
    new RegExp(`\\b${stateBias}\\b`, 'i').test(q)
  const inputWithBias =
    isValidStateBias && !alreadyMentionsState ? `${q} ${stateBias}` : q
  url.searchParams.set('input', inputWithBias)

  let res: Response
  try {
    res = await fetch(url.toString(), { cache: 'no-store' })
  } catch (err) {
    console.error('[places autocomplete] fetch failed:', err)
    return NextResponse.json(
      { error: 'Google Places request failed' },
      { status: 502 },
    )
  }
  if (!res.ok) {
    return NextResponse.json(
      { error: `Google Places returned ${res.status}` },
      { status: 502 },
    )
  }
  const data = (await res.json()) as {
    status?: string
    predictions?: Array<{ description?: string; place_id?: string }>
    error_message?: string
  }
  // Google returns 200 with status="OVER_QUERY_LIMIT" / "REQUEST_DENIED"
  // / etc. — surface those as 502 so the client can fall back gracefully.
  if (data.status && data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    console.error(
      `[places autocomplete] Google status=${data.status}: ${data.error_message ?? '(no message)'}`,
    )
    return NextResponse.json(
      { error: `Google Places: ${data.status}` },
      { status: 502 },
    )
  }
  const allPredictions = (data.predictions ?? [])
    .filter((p) => p.description && p.place_id)
    .map((p) => ({
      description: p.description as string,
      placeId: p.place_id as string,
    }))

  // Strict state filter — when a state bias is provided, drop any
  // prediction whose description doesn't end in `, XX, USA` matching
  // that code. Google's "bias" is soft (it ranks in-state higher but
  // still returns out-of-state matches); Alex wants hard filtering
  // so a client in NJ never sees a CA suggestion.
  const predictions = isValidStateBias
    ? allPredictions.filter(
        (p) => extractStateFromDescription(p.description) === stateBias,
      )
    : allPredictions
  return NextResponse.json({ predictions })
}

/** Pull the state code out of a Google Places legacy autocomplete
 *  description like "123 Main St, Cerritos, CA, USA". Returns null
 *  if the description doesn't match the expected ", ST, USA" tail —
 *  caller treats that as "unknown state" and drops the suggestion
 *  when a strict bias is in effect. */
function extractStateFromDescription(description: string): string | null {
  const match = description.match(/,\s*([A-Z]{2}),\s*USA?\s*$/i)
  return match ? match[1].toUpperCase() : null
}
