import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { requireStaff } from '@/lib/auth-helpers'
import { buildOfficeState } from '@/lib/office/state'
import { readHidden } from '@/lib/office/hidden'
import { demoState, officeDemoAllowed } from '@/lib/office/demo'

/**
 * GET /api/office/state — the virtual office's bots + activity feed,
 * derived from real Hub records (src/lib/office/state.ts). Staff only.
 * `hidden` is what this person hid from their view (src/lib/office/hide-plan.ts).
 *
 *   ?demo=1  sample data, only outside production or with
 *            OFFICE_DEMO_ENABLED=1 (response carries demo: true).
 */
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const denial = await requireStaff()
  if (denial) return denial
  const demo = new URL(req.url).searchParams.get('demo') === '1'
  if (demo) {
    if (!officeDemoAllowed()) return NextResponse.json({ error: 'demo mode is disabled' }, { status: 404 })
    return NextResponse.json({ ...demoState(), hidden: {} }, { headers: { 'Cache-Control': 'no-store' } })
  }
  const session = await auth()
  const [state, hidden] = await Promise.all([buildOfficeState(), readHidden(session?.user?.email || session?.user?.id)])
  return NextResponse.json({ ...state, hidden }, { headers: { 'Cache-Control': 'no-store' } })
}
