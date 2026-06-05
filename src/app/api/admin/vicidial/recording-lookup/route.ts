import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import {
  findMostRecentRecording,
  findMostRecentRecordingSigned,
} from '@/lib/vicidial-recording-lookup'
import { getPublicOrigin } from '@/lib/gmail'

/**
 * GET /api/admin/vicidial/recording-lookup?phone=...&signed=1
 *
 * Manual lookup for testing or one-off admin use. The
 * auto-attach happens silently inside the appointment / callback
 * POST handlers; this endpoint surfaces the same lookup so admin
 * can verify what Vicidial returns for a given customer phone
 * before relying on the auto-attach in production.
 *
 * Admin/member only. Set ?signed=1 to also return a signed proxy
 * URL ready for a browser <a href> (matches what the recording-
 * proxy lib would produce).
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const url = new URL(req.url)
  const phone = (url.searchParams.get('phone') || '').trim()
  if (!phone) {
    return NextResponse.json(
      { error: 'phone query param required' },
      { status: 400 },
    )
  }
  const signed = url.searchParams.get('signed') === '1'

  if (signed) {
    const result = await findMostRecentRecordingSigned({
      phone,
      hubOrigin: getPublicOrigin(req),
    })
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'no-store' },
    })
  }
  const result = await findMostRecentRecording({ phone })
  return NextResponse.json(result, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
