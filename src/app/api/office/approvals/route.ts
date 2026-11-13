import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { requireAdmin } from '@/lib/auth-helpers'
import { decideClientNumber } from '@/lib/hl/number-request'

/**
 * POST /api/office/approvals { id, decision } — answer a bot's question in the
 * Office. Today the only kind is Echo asking about a new client's toll-free
 * number: 'hl' (or 'yes') buys a Hell-level number right away; 'ghl' waits
 * while a person passes GHL's ID check (and answers with the link);
 * 'identified' hands the GHL route to the browser worker; 'no' declines.
 * Admin only, since it spends money.
 */
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const denied = await requireAdmin()
  if (denied) return denied
  const body = (await req.json().catch(() => null)) as { id?: unknown; decision?: unknown } | null
  const id = typeof body?.id === 'string' ? body.id.trim() : ''
  const DECISIONS = ['yes', 'hl', 'ghl', 'identified', 'no'] as const
  const decision = DECISIONS.find((d) => d === body?.decision) ?? null
  if (!id || !decision) return NextResponse.json({ error: 'send { "id": "...", "decision": "hl" | "ghl" | "identified" | "no" }' }, { status: 400 })
  const session = await auth()
  const by = session?.user?.name || session?.user?.email || 'an admin'
  const res = await decideClientNumber(id, decision, by)
  if (!res.ok) return NextResponse.json({ error: res.reason }, { status: 409 })
  return NextResponse.json(res)
}
