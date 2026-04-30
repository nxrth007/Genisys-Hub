import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { backfillLoggedAtTimestamps } from '@/lib/drive'

/**
 * POST /api/admin/sheets/backfill-logged-at
 *
 * Stamps every blank Logged At cell on the master spreadsheet with
 * the current timestamp, so the "Booked today" filter on Master
 * Tracker can include rows that the call center typed straight into
 * the sheet without filling in the timestamp column.
 *
 * Idempotent — rows that already have a Logged At value are skipped,
 * so re-running won't overwrite legitimate Hub-synced timestamps.
 */
export async function POST() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  // Middleware already gates /api/admin/* to role=admin, so we can
  // trust the session here.
  try {
    const result = await backfillLoggedAtTimestamps()
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.error('[sheets backfill-logged-at] failed:', err)
    const message = err instanceof Error ? err.message : 'Backfill failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
