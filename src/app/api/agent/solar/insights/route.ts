import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { getSolarInsights } from '@/lib/solar'

/**
 * GET /api/agent/solar/insights?address=...
 *
 * Looks up Google Solar API building insights for the given address.
 * Cache-first — same address resolved twice in this lifetime returns
 * the cached payload without re-billing the upstream API. Returns:
 *
 *   200 { summary }       — viability, sunshine hours, panel count, etc.
 *   400 { error }         — missing address
 *   503 { error }         — vault entry "Google Maps Key" missing
 *   422 { error }         — geocoder couldn't find the address, or
 *                           Google Solar has no data for that location
 *
 * Available to agents (Mary) — she clicks the "Check solar potential"
 * button on the booking form and the result renders inline.
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const address = req.nextUrl.searchParams.get('address')?.trim() ?? ''
  if (!address) {
    return NextResponse.json(
      { error: 'address is required' },
      { status: 400 }
    )
  }

  try {
    const summary = await getSolarInsights(address)
    return NextResponse.json({ summary })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'lookup failed'
    // Vault key missing → 503 so the UI can render a clean "feature
    // not configured" message rather than a generic error stripe.
    if (
      err instanceof Error &&
      err.message.toLowerCase().includes('vault entry')
    ) {
      return NextResponse.json({ error: message }, { status: 503 })
    }
    // "Couldn't find that address" or "no data for this location"
    // are user-correctable input errors; 422 separates them from
    // genuine 500-class server failures.
    if (
      err instanceof Error &&
      (err.message.includes("Couldn't find") ||
        err.message.includes('Couldn’t resolve') ||
        err.message.toLowerCase().includes('no data'))
    ) {
      return NextResponse.json({ error: message }, { status: 422 })
    }
    console.error('[solar insights]', err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
