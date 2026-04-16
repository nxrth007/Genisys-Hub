import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { getAuthUrl } from '@/lib/gmail'

/**
 * GET /api/gmail/connect
 * Starts the Gmail OAuth flow. Redirects to Google's consent screen.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const url = getAuthUrl()
    return NextResponse.redirect(url)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to build auth URL'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
