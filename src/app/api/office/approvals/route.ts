import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { requireAdmin } from '@/lib/auth-helpers'
import { decideNumber } from '@/lib/ghl-number/queue'

/**
 * POST /api/office/approvals { id, decision: 'yes' | 'no' } — answer a bot's
 * question in the Office. Today the only kind is Atlas asking to buy a
 * client's toll-free number: Yes queues the purchase and move, No drops it.
 * Admin only, since Yes spends money.
 */
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const denied = await requireAdmin()
  if (denied) return denied
  const body = (await req.json().catch(() => null)) as { id?: unknown; decision?: unknown } | null
  const id = typeof body?.id === 'string' ? body.id.trim() : ''
  const decision = body?.decision === 'yes' || body?.decision === 'no' ? body.decision : null
  if (!id || !decision) return NextResponse.json({ error: 'send { "id": "...", "decision": "yes" | "no" }' }, { status: 400 })
  const session = await auth()
  const by = session?.user?.name || session?.user?.email || 'an admin'
  const res = await decideNumber(id, decision, by)
  if (!res.ok) return NextResponse.json({ error: res.reason }, { status: 409 })
  return NextResponse.json(res)
}
