import { NextRequest, NextResponse } from 'next/server'
import { seoError, seoGuard } from '@/lib/seo/http'
import { seoPauseState, setSeoPaused } from '@/lib/seo/pause'

/** GET /api/seo/pause — whether all SEO automation is paused, and why. */
export async function GET() {
  const guard = await seoGuard()
  if (guard instanceof NextResponse) return guard
  return NextResponse.json({ pause: await seoPauseState() })
}

/** PATCH /api/seo/pause { paused: boolean } — pause or resume all SEO automation. Deletes nothing. */
export async function PATCH(req: NextRequest) {
  const guard = await seoGuard()
  if (guard instanceof NextResponse) return guard
  let body: { paused?: unknown }
  try {
    body = (await req.json()) as { paused?: unknown }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (typeof body.paused !== 'boolean') return NextResponse.json({ error: '`paused` must be true or false' }, { status: 400 })
  try {
    const pause = await setSeoPaused(body.paused, guard.email)
    console.log(`[seo] automation ${body.paused ? 'PAUSED' : 'resumed'} by ${guard.email}`)
    return NextResponse.json({ pause })
  } catch (err) {
    return seoError(err, 'pause')
  }
}
