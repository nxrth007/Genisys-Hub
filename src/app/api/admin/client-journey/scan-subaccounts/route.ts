import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { requireAdmin } from '@/lib/auth-helpers'
import { rejectSubaccountMatch, scanSubaccounts } from '@/lib/subaccount-autolink'

/**
 * POST /api/admin/client-journey/scan-subaccounts[?dryRun=true]
 *
 * Scan GHL sub-accounts and link clear matches to clients that have none.
 * dryRun=true (query or body) returns proposed links + needs-review pairs
 * without writing anything. Body may also carry
 * { reject: [{ clientId, locationId }] } to stop suggesting those pairs.
 */
export async function POST(req: Request) {
  const denial = await requireAdmin()
  if (denial) return denial
  const body = (await req.json().catch(() => null)) as { dryRun?: unknown; reject?: unknown } | null
  const q = new URL(req.url).searchParams.get('dryRun')
  const dryRun = q === 'true' || q === '1' || body?.dryRun === true
  const session = await auth()
  if (!dryRun && Array.isArray(body?.reject)) {
    for (const r of body.reject as { clientId?: unknown; locationId?: unknown }[]) {
      if (typeof r?.clientId === 'string' && typeof r?.locationId === 'string') await rejectSubaccountMatch(r.clientId, r.locationId)
    }
  }
  try {
    return NextResponse.json(await scanSubaccounts({ dryRun, actor: session?.user?.id ?? null }))
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 })
  }
}
