import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { getAuthUrl } from '@/lib/gmail'

/**
 * GET /api/gmail/connect
 * Starts the Gmail OAuth flow. Derives the redirect URI from the incoming
 * request origin so it always matches the actual deployment host.
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const origin = req.nextUrl.origin // e.g. "https://genisys-hub.onrender.com"
    const url = getAuthUrl(origin)
    return NextResponse.redirect(url)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to build auth URL'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
