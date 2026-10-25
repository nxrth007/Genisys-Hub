import { NextRequest, NextResponse } from 'next/server'
import { getPublicOrigin } from '@/lib/drive'
import { connectTarget, googleConsentUrl, readShareToken } from '@/lib/hl/google-calendar'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'

type Ctx = { params: Promise<{ token: string }> }

/**
 * GET: from a team member's connect link (/hl/connect/<token>) on to
 * Google's sign-in. The signed token is the access; Google sends them back
 * to /hl/connect/done.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { token } = await params
  const origin = getPublicOrigin(req)
  const done = (error: string) => NextResponse.redirect(`${origin}/hl/connect/done?error=${encodeURIComponent(error)}`)
  const limit = checkRateLimit(`hl-cal-connect:${clientIp(req) ?? 'unknown'}`, 20, 10 * 60_000)
  if (!limit.ok) return done('Too many tries from here. Please wait a few minutes.')
  const t = readShareToken(token)
  if (!t || !(await connectTarget(t.accountId, t.staffKey))) return done('This connect link has expired. Ask for a new one.')
  try {
    return NextResponse.redirect(await googleConsentUrl(origin, { accountId: t.accountId, staffKey: t.staffKey, back: 'page' }))
  } catch (err) {
    return done(err instanceof Error ? err.message : 'Google sign-in isn’t set up yet.')
  }
}
