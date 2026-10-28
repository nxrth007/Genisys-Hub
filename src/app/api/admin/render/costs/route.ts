import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-helpers'
import { isWorkspacePlan, renderCosts, setWorkspacePlan } from '@/lib/render-costs'

/**
 * GET /api/admin/render/costs[?refresh=1]
 *   What the Hub's Render workspace costs a month, priced from Render's API
 *   (see lib/render-costs.ts).
 * PUT { plan: 'hobby' | 'pro' | 'scale' }
 *   The workspace plan, which Render's API doesn't report.
 *
 * Admin-only; the Render key never leaves the server.
 */
export async function GET(req: NextRequest) {
  const denial = await requireAdmin()
  if (denial) return denial
  try {
    return NextResponse.json(await renderCosts({ refresh: req.nextUrl.searchParams.has('refresh') }))
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 })
  }
}

export async function PUT(req: NextRequest) {
  const denial = await requireAdmin()
  if (denial) return denial
  const plan = ((await req.json().catch(() => null)) as { plan?: unknown } | null)?.plan
  if (!isWorkspacePlan(plan)) {
    return NextResponse.json({ error: 'plan must be hobby, pro or scale' }, { status: 400 })
  }
  await setWorkspacePlan(plan)
  try {
    return NextResponse.json(await renderCosts())
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 })
  }
}
