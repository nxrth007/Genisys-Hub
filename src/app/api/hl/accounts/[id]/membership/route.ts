import { NextResponse } from 'next/server'
import { hlGuard } from '@/lib/hl/http'
import { readMembership } from '@/lib/hl/membership'

/**
 * GET /api/hl/accounts/:id/membership — the client's membership with Genisys, for Hell-level →
 * Memberships (Alex, 2026-11-14): when they registered, when they got their sub-account, and what
 * has happened since. Read-only, and Genisys only (a sub-account's own login has no Memberships).
 */
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const membership = await readMembership(id)
  if (!membership) return NextResponse.json({ error: 'Sub-account not found' }, { status: 404 })
  return NextResponse.json({ membership })
}
