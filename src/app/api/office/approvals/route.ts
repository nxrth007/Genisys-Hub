import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { requireAdmin } from '@/lib/auth-helpers'
import { decideClientNumber } from '@/lib/hl/number-request'

/**
 * POST /api/office/approvals { id, decision: 'yes' | 'no' } — answer a bot's
 * question in the Office. Today the only kind is Echo asking to buy a new
 * client's Hell-level toll-free number: Yes buys it on Genisys's Twilio right
 * away (and answers with the number), No drops it. Admin only, since Yes
 * spends money.
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
  const res = await decideClientNumber(id, decision, by)
  if (!res.ok) return NextResponse.json({ error: res.reason }, { status: 409 })
  return NextResponse.json(res)
}
