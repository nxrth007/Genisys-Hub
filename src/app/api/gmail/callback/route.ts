import { NextRequest, NextResponse } from 'next/server'
import { exchangeCode } from '@/lib/gmail'

/**
 * GET /api/gmail/callback
 * Google redirects here after the user consents. Derives the base URL from
 * the request origin so the OAuth2 client uses the correct redirect_uri
 * during code exchange (Google validates it matches the auth request).
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  if (!code) {
    return NextResponse.redirect(new URL('/settings?gmail_error=no_code', req.url))
  }

  try {
    const origin = req.nextUrl.origin
    const account = await exchangeCode(code, origin)
    return NextResponse.redirect(
      new URL(`/settings?gmail_connected=${encodeURIComponent(account.email)}`, req.url)
    )
  } catch (err) {
    console.error('[gmail/callback] exchange failed:', err)
    const message = err instanceof Error ? err.message : 'unknown'
    return NextResponse.redirect(
      new URL(`/settings?gmail_error=${encodeURIComponent(message)}`, req.url)
    )
  }
}
