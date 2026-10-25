import { NextResponse } from 'next/server'
import { hlAccountOr404, hlAccountGuard } from '@/lib/hl/http'
import { dashboardStats } from '@/lib/hl/stats'

type Ctx = { params: Promise<{ id: string }> }

/** GET ?days=30: the sub-account's dashboard numbers. */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params
  const guard = await hlAccountGuard(id)
  if (guard instanceof NextResponse) return guard
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  const days = Math.min(90, Math.max(7, Number(new URL(req.url).searchParams.get('days')) || 30))
  return NextResponse.json(await dashboardStats(id, days))
}
