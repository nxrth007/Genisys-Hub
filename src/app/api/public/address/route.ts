import { NextRequest, NextResponse } from 'next/server'
import { placesApiKey } from '@/lib/places-key'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'

/**
 * Business-address suggestions for the client onboarding form
 * (clientonboarding.leadgenisys.com, repo nxrth007/genisysclientonboarding),
 * so a client picks a real street address instead of typing one wrong:
 *
 *   GET ?q=<typed>&session=<id>     → { suggestions: [{ id, main, secondary }] }
 *   GET ?place=<id>&session=<id>    → { address, street, city, state, zip }
 *
 * Google Places Autocomplete (New) through the Vault's "Places API (New)" key
 * (lib/places-key.ts), so the form needs no key of its own; one session token per address typed bills the
 * lookups as one. Public, since the form's visitors have no Hub login: it
 * answers only the form's own origins, rate-limits each visitor and caps the
 * day's lookups. Anything going wrong answers with no suggestions, and the form
 * falls back to plain typing.
 */

export const dynamic = 'force-dynamic'

const ORIGINS = [/^https:\/\/clientonboarding\.leadgenisys\.com$/, /^https:\/\/[a-z0-9-]+\.lovable\.app$/, /^https:\/\/[a-z0-9-]+\.lovableproject\.com$/]
const SESSION = /^[A-Za-z0-9-]{8,64}$/
const PLACE = /^[A-Za-z0-9_-]{10,300}$/

/** Google's status ("PERMISSION_DENIED", "INVALID_ARGUMENT") rides along to the answer; its message stays in the log. */
class LookupError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message)
  }
}

let cachedKey: { key: string; at: number } | null = null
async function mapsKey(): Promise<string> {
  if (cachedKey && Date.now() - cachedKey.at < 10 * 60_000) return cachedKey.key
  const key = await placesApiKey()
  cachedKey = { key, at: Date.now() }
  return key
}

function corsHeaders(origin: string | null): Record<string, string> {
  return origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, OPTIONS', Vary: 'Origin' } : {}
}

const allowedOrigin = (req: NextRequest) => {
  const origin = req.headers.get('origin')
  return origin && ORIGINS.some((re) => re.test(origin)) ? origin : null
}

export function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(allowedOrigin(req)) })
}

export async function GET(req: NextRequest) {
  const origin = allowedOrigin(req)
  const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: corsHeaders(origin) })
  if (!origin) return json({ error: 'forbidden' }, 403)
  // A typed address is ~10 lookups; an hour of a person typing stays well under this.
  if (!checkRateLimit(`address:${clientIp(req)}`, 60, 10 * 60_000).ok) return json({ suggestions: [] }, 429)
  if (!checkRateLimit('address:all', 2000, 24 * 60 * 60_000).ok) return json({ suggestions: [] }, 429)

  const q = req.nextUrl.searchParams
  const session = q.get('session') ?? ''
  if (!SESSION.test(session)) return json({ error: 'session required' }, 400)

  try {
    const key = await mapsKey()
    const place = q.get('place')
    if (place) {
      if (!PLACE.test(place)) return json({ error: 'bad place' }, 400)
      const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(place)}?sessionToken=${encodeURIComponent(session)}`, {
        headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'formattedAddress,addressComponents' },
        signal: AbortSignal.timeout(8000),
      })
      const data = (await res.json().catch(() => ({}))) as {
        formattedAddress?: string
        addressComponents?: { longText?: string; shortText?: string; types?: string[] }[]
        error?: { message?: string; status?: string }
      }
      if (!res.ok) throw new LookupError(data.error?.message || `Places HTTP ${res.status}`, data.error?.status || `HTTP_${res.status}`)
      const part = (type: string, short = false) => {
        const c = data.addressComponents?.find((x) => x.types?.includes(type))
        return (short ? c?.shortText : c?.longText) ?? ''
      }
      const street = [part('street_number'), part('route', true)].filter(Boolean).join(' ')
      const unit = part('subpremise')
      const city = part('locality') || part('postal_town') || part('sublocality') || part('administrative_area_level_3')
      return json({
        address: (data.formattedAddress ?? '').replace(/,\s*USA$/, ''),
        street: unit ? `${street} #${unit}` : street,
        city,
        state: part('administrative_area_level_1', true),
        zip: part('postal_code'),
      })
    }

    const input = (q.get('q') ?? '').trim().slice(0, 200)
    if (input.length < 3) return json({ suggestions: [] })
    const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
      body: JSON.stringify({ input, sessionToken: session, includedRegionCodes: ['us'], includedPrimaryTypes: ['street_address', 'premise', 'subpremise'] }),
      signal: AbortSignal.timeout(8000),
    })
    const data = (await res.json().catch(() => ({}))) as {
      suggestions?: { placePrediction?: { placeId?: string; text?: { text?: string }; structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } } } }[]
      error?: { message?: string; status?: string }
    }
    if (!res.ok) throw new LookupError(data.error?.message || `Places HTTP ${res.status}`, data.error?.status || `HTTP_${res.status}`)
    const suggestions = (data.suggestions ?? [])
      .map((s) => s.placePrediction)
      .filter((p): p is NonNullable<typeof p> => !!p?.placeId)
      .map((p) => ({
        id: p.placeId!,
        main: p.structuredFormat?.mainText?.text ?? p.text?.text ?? '',
        secondary: (p.structuredFormat?.secondaryText?.text ?? '').replace(/,\s*USA$/, ''),
      }))
    return json({ suggestions })
  } catch (err) {
    console.warn('[address] lookup failed:', err instanceof Error ? err.message : err)
    return json({ suggestions: [], reason: err instanceof LookupError ? err.reason : 'lookup_failed' }, 502)
  }
}
