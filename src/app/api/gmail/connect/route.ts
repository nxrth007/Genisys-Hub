import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { getAuthUrl, getPublicOrigin } from '@/lib/gmail'

/**
 * GET /api/gmail/connect
 * Starts the Gmail OAuth flow. Uses proxy headers (host + x-forwarded-proto)
 * to derive the public origin, so the redirect URI matches the registered
 * Cloud Console URI regardless of Render's internal port assignment.
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const origin = getPublicOrigin(req)
    const url = getAuthUrl(origin)
    return NextResponse.redirect(url)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to build auth URL'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
