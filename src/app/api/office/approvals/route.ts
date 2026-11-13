import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { requireAdmin } from '@/lib/auth-helpers'
import { decideGhlRegistration } from '@/lib/ghl-number/queue'
import { decideClientNumber } from '@/lib/hl/number-request'

/**
 * POST /api/office/approvals { id, decision, kind? } — answer a bot's question
 * in the Office. Admin only, since it spends money or files for a client.
 *
 * Echo asking about a new client's toll-free number (kind "number", the
 * default): 'hl' (or 'yes') buys a Hell-level number right away; 'ghl' waits
 * while a person passes GHL's ID check (and answers with the link);
 * 'identified' hands the GHL route to the browser worker; 'no' declines.
 *
 * Echo asking about GHL's toll-free registration it filled (kind
 * "registration", id = the GHL number job): 'submit' fills it again and sends
 * it; 'hold' leaves it; 'retry' fills it again and asks again.
 */
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const denied = await requireAdmin()
  if (denied) return denied
  const body = (await req.json().catch(() => null)) as { id?: unknown; kind?: unknown; decision?: unknown } | null
  const id = typeof body?.id === 'string' ? body.id.trim() : ''
  const session = await auth()
  const by = session?.user?.name || session?.user?.email || 'an admin'
  if (body?.kind === 'registration') {
    const REGISTRATION = ['submit', 'hold', 'retry'] as const
    const decision = REGISTRATION.find((d) => d === body?.decision) ?? null
    if (!id || !decision) return NextResponse.json({ error: 'send { "id": "...", "kind": "registration", "decision": "submit" | "hold" | "retry" }' }, { status: 400 })
    const res = await decideGhlRegistration(id, decision, by)
    if (!res.ok) return NextResponse.json({ error: res.reason }, { status: 409 })
    return NextResponse.json(res)
  }
  const DECISIONS = ['yes', 'hl', 'ghl', 'identified', 'no'] as const
  const decision = DECISIONS.find((d) => d === body?.decision) ?? null
  if (!id || !decision) return NextResponse.json({ error: 'send { "id": "...", "decision": "hl" | "ghl" | "identified" | "no" }' }, { status: 400 })
  const res = await decideClientNumber(id, decision, by)
  if (!res.ok) return NextResponse.json({ error: res.reason }, { status: 409 })
  return NextResponse.json(res)
}
