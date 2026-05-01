import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { getSecretByName } from '@/lib/vault-service'

/**
 * GET /api/agent/maps/embed-url?address=...
 *
 * Resolves a Google Maps Embed API URL for the supplied address,
 * pulling the API key from the vault on the server side. Returns:
 *   200 { url }     — embed URL ready for an <iframe src=...>
 *   400             — address missing
 *   503 { error }   — vault key not configured yet
 *
 * Why this lives behind an endpoint instead of pasting the key into
 * a public env var: keeping the API key in the vault lets us rotate
 * it without a redeploy, and the server handles the lookup so we
 * don't ship the key into bundle code (it still leaks into the
 * iframe URL — that's the model Google's Embed API expects, and the
 * key itself is locked down via HTTP-referrer restrictions in
 * Google Cloud Console).
 */
const VAULT_KEY_NAME = 'Google Maps API Key'

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const address = req.nextUrl.searchParams.get('address')?.trim() ?? ''
  if (!address) {
    return NextResponse.json({ error: 'address is required' }, { status: 400 })
  }

  let key: string
  try {
    key = await getSecretByName(VAULT_KEY_NAME)
  } catch {
    // Missing vault entry isn't a 500 — it's a "feature not
    // configured yet" state. The form treats 503 as "hide the
    // preview block silently" so it can be deployed before the key
    // lands and just light up automatically once it does.
    return NextResponse.json(
      {
        error: `Add a vault entry named "${VAULT_KEY_NAME}" to enable the address preview.`,
      },
      { status: 503 }
    )
  }

  const url = `https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(
    key
  )}&q=${encodeURIComponent(address)}`
  return NextResponse.json({ url })
}
