import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import { buildOfficeState } from '@/lib/office/state'
import { demoState, officeDemoAllowed } from '@/lib/office/demo'

/**
 * GET /api/office/state — the virtual office's bots + activity feed,
 * derived from real Hub records (src/lib/office/state.ts). Staff only.
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
    return NextResponse.json(demoState(), { headers: { 'Cache-Control': 'no-store' } })
  }
  return NextResponse.json(await buildOfficeState(), { headers: { 'Cache-Control': 'no-store' } })
}
