import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { requireStaff } from '@/lib/auth-helpers'
import { backfillFromSheet } from '@/lib/tracker/sheet-sync'

/**
 * POST { dryRun?: boolean } → one-way Google Sheet -> DB backfill.
 * Dry run (the default) only reports what would change. Never writes the
 * sheet, never creates clients. Staff only.
 */
export async function POST(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied
  const body = (await req.json().catch(() => ({}))) as { dryRun?: unknown }
  const session = await auth()
  const summary = await backfillFromSheet({ dryRun: body?.dryRun !== false, actor: session?.user?.id ?? 'staff' })
  return NextResponse.json(summary, { status: summary.error ? 502 : 200 })
}
