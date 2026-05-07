import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { getSecretByName } from '@/lib/vault-service'

/**
 * GET /api/client/maps/places/autocomplete?q=...&state=...
 *
 * Parallel to /api/agent/maps/places/autocomplete — same Google
 * Places passthrough, scoped to the client onboarding flow. We
 * don't reuse the agent endpoint because the middleware allowlists
 * are different (agent endpoints are gated to role=agent; this one
 * is allowed for client_pending / client_onboarding so a prospect
 * filling out the onboarding form can use autocomplete on their
 * business address).
 *
 * Auth required (any signed-in user) so the Google API key never
 * leaks to truly anonymous traffic. The middleware decides which
 * roles can reach this path.
 *
 * Query params:
 *   q       — required, the in-progress address text
 *   state   — optional 2-letter US state code; biases suggestions
 *             to that state. Useful when the form already has a
 *             State value (the onboarding form passes whatever the
 *             prospect entered above the address field).
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
  // text and let Google's NLP bias naturally toward that area.
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
    console.error('[client/places autocomplete] fetch failed:', err)
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
  if (data.status && data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    console.error(
      `[client/places autocomplete] Google status=${data.status}: ${data.error_message ?? '(no message)'}`,
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
  // that code. Mirror of the agent endpoint. Hard filtering so an
  // NJ client never sees CA suggestions.
  const predictions = isValidStateBias
    ? allPredictions.filter(
        (p) => extractStateFromDescription(p.description) === stateBias,
      )
    : allPredictions
  return NextResponse.json({ predictions })
}

/** Pull the state code out of a Google Places legacy autocomplete
 *  description like "123 Main St, Cerritos, CA, USA". Returns null
 *  when the tail doesn't match — caller drops the suggestion under
 *  strict bias. */
function extractStateFromDescription(description: string): string | null {
  const match = description.match(/,\s*([A-Z]{2}),\s*USA?\s*$/i)
  return match ? match[1].toUpperCase() : null
}
