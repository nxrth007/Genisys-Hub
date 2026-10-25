import { NextRequest, NextResponse } from 'next/server'
import { getPublicOrigin } from '@/lib/drive'
import { calendarCallbackRedirect } from '@/lib/hl/google-calendar'

/**
 * GET: Google's sign-in coming back through Hell-level's own Google app
 * (src/lib/hl/google-calendar.ts). Public: the signed state is the access,
 * as for a team member who came from their connect link with no Hub login.
 * Register this address in that app's OAuth client.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams
  return NextResponse.redirect(await calendarCallbackRedirect(getPublicOrigin(req), 'hl', q.get('code'), q.get('state') ?? '', q.get('error')))
}
