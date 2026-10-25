import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { exchangeCode, getPublicOrigin } from '@/lib/drive'
import { calendarCallbackRedirect, isCalendarState } from '@/lib/hl/google-calendar'
import { canAccessSeo } from '@/lib/seo/access'
import { GSC_OAUTH_SCOPES, GSC_OAUTH_STATE, setGscConnectedAccount } from '@/lib/seo/gsc'

/**
 * GET /api/drive/callback
 * Google redirects here after consent. Uses getPublicOrigin() for redirects
 * because req.url behind Render's proxy is the internal host.
 *
 * Shared by SEO's "Connect Search Console" (state = seo-gsc): same Google
 * sign-in and registered redirect, with the Search Console scopes added;
 * that flow returns to /seo instead of /settings. And by Hell-level's
 * Google Calendar connections (state = hl-cal.<signed>), which return to the
 * sub-account's Settings → Calendars → Connections, or to /hl/connect/done
 * for a team member who came from their connect link (no Hub account: the
 * middleware lets those through on the signed state alone).
 */
export async function GET(req: NextRequest) {
  const origin = getPublicOrigin(req)
  const code = req.nextUrl.searchParams.get('code')
  const state = req.nextUrl.searchParams.get('state')
  if (isCalendarState(state)) return calendarCallback(origin, code, state, req.nextUrl.searchParams.get('error'))
  const forSeo = state === GSC_OAUTH_STATE
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

/** A calendar sign-in through the Hub's own Google app (Hell-level's own app returns to /api/hl/public/google-calendar/callback). */
async function calendarCallback(origin: string, code: string | null, state: string, denied: string | null) {
  return NextResponse.redirect(await calendarCallbackRedirect(origin, 'hub', code, state, denied))
}
