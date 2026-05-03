import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { getSecretByName } from '@/lib/vault-service'

/**
 * GET /api/agent/maps/places/details?placeId=...
 *
 * Resolves a Google Place to its full formatted address (with ZIP)
 * and structured components. Called by the appointment form right
 * after Mary picks an autocomplete suggestion — predictions only
 * carry "Street, City, ST, USA" without a ZIP, but Details does.
 *
 * Field mask kept tight (formatted_address, address_components) so
 * we don't pay for fields we won't read. Address Component / Basic
 * Data tier; ~$0.017 per call.
 *
 * Returns:
 *   200 { formattedAddress, addressComponents }
 *     formattedAddress = "1141 Pleasant Hill Rd, Leander, TX 78641, USA"
 *     addressComponents = [{ short_name, long_name, types: [...] }]
 *   400 — placeId missing
 *   503 — vault key missing
 *   502 — Google replied with a non-OK status
 */
const VAULT_KEY_NAME = 'Google Maps Key'

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const placeId = req.nextUrl.searchParams.get('placeId')?.trim() ?? ''
  if (!placeId) {
    return NextResponse.json({ error: 'placeId is required' }, { status: 400 })
  }

  let key: string
  try {
    key = await getSecretByName(VAULT_KEY_NAME)
  } catch {
    return NextResponse.json(
      {
        error: `Add a vault entry named "${VAULT_KEY_NAME}" to enable Google Places.`,
      },
      { status: 503 },
    )
  }

  const url = new URL('https://maps.googleapis.com/maps/api/place/details/json')
  url.searchParams.set('place_id', placeId)
  url.searchParams.set('key', key)
  // Tight field mask — only what we need to format the address.
  url.searchParams.set('fields', 'formatted_address,address_components')

  let res: Response
  try {
    res = await fetch(url.toString(), { cache: 'no-store' })
  } catch (err) {
    console.error('[places details] fetch failed:', err)
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
    result?: {
      formatted_address?: string
      address_components?: Array<{
        short_name?: string
        long_name?: string
        types?: string[]
      }>
    }
    error_message?: string
  }
  if (data.status && data.status !== 'OK') {
    console.error(
      `[places details] Google status=${data.status}: ${data.error_message ?? '(no message)'}`,
    )
    return NextResponse.json(
      { error: `Google Places: ${data.status}` },
      { status: 502 },
    )
  }
  return NextResponse.json({
    formattedAddress: data.result?.formatted_address ?? '',
    addressComponents: data.result?.address_components ?? [],
  })
}
