import { NextRequest, NextResponse } from 'next/server'
import { exchangeCode, getPublicOrigin } from '@/lib/gmail'

/**
 * GET /api/gmail/callback
 * Google redirects here after consent. All redirects use getPublicOrigin()
 * instead of req.url — because req.url behind Render's proxy is the internal
 * host (localhost:10000), not the public URL.
 */
export async function GET(req: NextRequest) {
  const origin = getPublicOrigin(req)
  const code = req.nextUrl.searchParams.get('code')

  if (!code) {
    return NextResponse.redirect(`${origin}/settings?gmail_error=no_code`)
  }

  try {
    const account = await exchangeCode(code, origin)
    return NextResponse.redirect(
      `${origin}/settings?gmail_connected=${encodeURIComponent(account.email)}`
    )
  } catch (err) {
    console.error('[gmail/callback] exchange failed:', err)
    const message = err instanceof Error ? err.message : 'unknown'
    return NextResponse.redirect(
      `${origin}/settings?gmail_error=${encodeURIComponent(message)}`
    )
  }
}
