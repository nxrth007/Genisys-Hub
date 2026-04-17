import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { getAuthUrl, getPublicOrigin } from '@/lib/drive'

/**
 * GET /api/drive/connect
 * Starts the Drive OAuth flow. Derives the public origin from proxy headers so
 * the redirect URI matches the one registered in Google Cloud Console, even
 * behind Render's reverse proxy.
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
