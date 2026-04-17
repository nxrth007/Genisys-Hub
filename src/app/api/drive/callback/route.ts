import { NextRequest, NextResponse } from 'next/server'
import { exchangeCode, getPublicOrigin } from '@/lib/drive'

/**
 * GET /api/drive/callback
 * Google redirects here after consent. Uses getPublicOrigin() for redirects
 * because req.url behind Render's proxy is the internal host.
 */
export async function GET(req: NextRequest) {
  const origin = getPublicOrigin(req)
  const code = req.nextUrl.searchParams.get('code')

  if (!code) {
    return NextResponse.redirect(`${origin}/settings?drive_error=no_code`)
  }

  try {
    const account = await exchangeCode(code, origin)
    return NextResponse.redirect(
      `${origin}/settings?drive_connected=${encodeURIComponent(account.email)}`
    )
  } catch (err) {
    console.error('[drive/callback] exchange failed:', err)
    const message = err instanceof Error ? err.message : 'unknown'
    return NextResponse.redirect(
      `${origin}/settings?drive_error=${encodeURIComponent(message)}`
    )
  }
}
