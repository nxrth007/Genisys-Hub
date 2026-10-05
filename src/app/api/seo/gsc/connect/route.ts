import { NextRequest, NextResponse } from 'next/server'
import { getAuthUrl, getPublicOrigin } from '@/lib/drive'
import { GSC_OAUTH_SCOPES, GSC_OAUTH_STATE, setGscConnectedAccount } from '@/lib/seo/gsc'
import { seoError, seoGuard } from '@/lib/seo/http'

/**
 * GET /api/seo/gsc/connect — off to Google to grant Search Console + Site
 * Verification on the Hub's existing Google sign-in. Google comes back to
 * /api/drive/callback (the redirect address already registered for the
 * Hub), which sees `state` and returns here to /seo.
 *
 * DELETE — stop using that account for Search Console. The Google sign-in
 * itself stays (Drive and Sheets use it too).
 */
export async function GET(req: NextRequest) {
  const guard = await seoGuard()
  if (guard instanceof NextResponse) return guard
  return NextResponse.redirect(getAuthUrl(getPublicOrigin(req), GSC_OAUTH_STATE, GSC_OAUTH_SCOPES))
}

export async function DELETE() {
  const guard = await seoGuard()
  if (guard instanceof NextResponse) return guard
  try {
    await setGscConnectedAccount(null)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return seoError(err, 'disconnect Search Console')
  }
}
