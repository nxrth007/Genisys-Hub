import { NextRequest, NextResponse } from 'next/server'
import { exchangeCode, getPublicOrigin } from '@/lib/gmail'

/**
 * GET /api/gmail/callback
 * Google redirects here after consent. Uses the same public-origin derivation
 * as the connect route so the redirect_uri matches during code exchange
 * (Google validates it against what was used in the authorization request).
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  if (!code) {
    return NextResponse.redirect(new URL('/settings?gmail_error=no_code', req.url))
  }

  try {
    const origin = getPublicOrigin(req)
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
