import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import { trackerClient } from '@/lib/tracker/store'

/**
 * One client's tracker page (src/app/tracker/[clientId]): the derived row,
 * the contact and business details from the onboarding form, the Stripe read
 * and the hand-mark history. Staff only.
 *   GET ?refresh=1 → { row, profile, billing, events, asOf }
 */
type Ctx = { params: Promise<{ clientId: string }> }

export async function GET(req: Request, ctx: Ctx) {
  const denied = await requireStaff()
  if (denied) return denied
  const { clientId } = await ctx.params
  const refresh = new URL(req.url).searchParams.get('refresh') === '1'
  const detail = await trackerClient(clientId, { refresh })
  if (!detail) return NextResponse.json({ error: 'client not found' }, { status: 404 })
  return NextResponse.json(detail)
}
