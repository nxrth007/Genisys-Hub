import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { reconcileMissingAppointments } from '@/lib/appointment-sync'

/**
 * POST /api/admin/sheets/reconcile-missing
 *
 * Re-run the sheet sync for every Appointment in the DB that's
 * currently missing from the master sheet. One-click recovery for
 * the "/clients shows 25 booked but master tracker shows 21" gap.
 *
 * Idempotent — already-synced rows aren't re-touched (the helper
 * scans before retrying so it picks up the post-fix state). Sequential,
 * not parallel, to avoid races on the next-row-number allocation
 * when multiple appends happen concurrently.
 *
 * Middleware already gates /api/admin/* to role=admin.
 */
export async function POST() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  try {
    const result = await reconcileMissingAppointments()
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.error('[sheets reconcile-missing] failed:', err)
    const message = err instanceof Error ? err.message : 'reconcile failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
