import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { exchangeCode, getPublicOrigin } from '@/lib/drive'
import { canAccessSeo } from '@/lib/seo/access'
import { GSC_OAUTH_SCOPES, GSC_OAUTH_STATE, setGscConnectedAccount } from '@/lib/seo/gsc'

/**
 * GET /api/drive/callback
 * Google redirects here after consent. Uses getPublicOrigin() for redirects
 * because req.url behind Render's proxy is the internal host.
 *
 * Shared by SEO's "Connect Search Console" (state = seo-gsc): same Google
 * sign-in and registered redirect, with the Search Console scopes added;
 * that flow returns to /seo instead of /settings.
 */
export async function GET(req: NextRequest) {
  const origin = getPublicOrigin(req)
  const code = req.nextUrl.searchParams.get('code')
  const forSeo = req.nextUrl.searchParams.get('state') === GSC_OAUTH_STATE
  const back = (q: string) => NextResponse.redirect(`${origin}${forSeo ? '/seo' : '/settings'}?${q}`)

  if (!code) {
    const denied = req.nextUrl.searchParams.get('error')
    return back(forSeo ? `gsc_error=${encodeURIComponent(denied ? `Google sign-in was cancelled (${denied}).` : 'Google sent no sign-in code.')}` : 'drive_error=no_code')
  }

  if (forSeo) {
    // Only the SEO allowlist chooses which Google account owns the sites in Search Console.
    const session = await auth()
    if (!canAccessSeo(session?.user?.email)) return NextResponse.redirect(`${origin}/today`)
  }

  try {
    const account = await exchangeCode(code, origin)
    if (forSeo) {
      const granted = account.grantedScopes.split(/\s+/)
      if (!GSC_OAUTH_SCOPES.every((s) => granted.includes(s))) {
        return back(
          `gsc_error=${encodeURIComponent('Google didn’t grant Search Console access. Connect again and leave both Search Console boxes ticked on Google’s screen.')}`,
        )
      }
      await setGscConnectedAccount(account.email)
      return back(`gsc_connected=${encodeURIComponent(account.email)}`)
    }
    return back(`drive_connected=${encodeURIComponent(account.email)}`)
  } catch (err) {
    console.error('[drive/callback] exchange failed:', err)
    const message = err instanceof Error ? err.message : 'unknown'
    return back(`${forSeo ? 'gsc_error' : 'drive_error'}=${encodeURIComponent(message)}`)
  }
}
