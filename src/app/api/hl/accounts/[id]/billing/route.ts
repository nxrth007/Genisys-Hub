import { NextResponse } from 'next/server'
import { hlGuard } from '@/lib/hl/http'
import { readBilling } from '@/lib/hl/billing'

/**
 * GET /api/hl/accounts/:id/billing — the client's Whop membership and payments, for Hell-level →
 * Memberships. Read only (Alex, 2026-11-14): nothing here changes anything on Whop. Genisys only.
 */
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  try {
    const view = await readBilling(id)
    if (!view) return NextResponse.json({ error: 'Sub-account not found' }, { status: 404 })
    return NextResponse.json(view)
  } catch (err) {
    return NextResponse.json({ error: `Couldn’t read Whop: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 })
  }
}
