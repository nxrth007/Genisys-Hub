import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { exchangeCode, getPublicOrigin } from '@/lib/drive'
import { finishGoogleConnect, isCalendarState, readConnectState } from '@/lib/hl/google-calendar'
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

async function calendarCallback(origin: string, code: string | null, state: string, denied: string | null) {
  const s = readConnectState(state)
  const page = (q: string) => NextResponse.redirect(`${origin}/hl/connect/done?${q}`)
  if (!s) return page(`error=${encodeURIComponent('That sign-in took too long or the link was changed. Open your connect link and try again.')}`)
  const back = (ok: string | null, error?: string) =>
    s.back === 'page'
      ? page(ok ? 'connected=1' : `error=${encodeURIComponent(error ?? '')}`)
      : NextResponse.redirect(`${origin}/hell-level/${s.accountId}/settings?tab=calendars&section=connections&${ok ? `gcal_connected=${encodeURIComponent(ok)}` : `gcal_error=${encodeURIComponent(error ?? '')}`}`)
  if (!code) return back(null, denied ? 'Google sign-in was cancelled.' : 'Google sent no sign-in code.')
  try {
    const { email } = await finishGoogleConnect(code, origin, s)
    return back(email)
  } catch (err) {
    console.error('[drive/callback] calendar connect failed:', err)
    return back(null, err instanceof Error ? err.message : 'Google sign-in failed.')
  }
}
