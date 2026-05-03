import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { findAppointmentsMissingFromSheet } from '@/lib/appointment-sync'

/**
 * GET /api/admin/sheets/missing-from-sheet
 *
 * Diagnostic for the "/clients page count > master tracker count"
 * gap. Returns every Appointment in the DB that doesn't have a
 * matching row in the master sheet, classified by reason.
 *
 * Powers the Settings → Sheet Maintenance reconciliation card so
 * admin can see the gap before clicking the reconcile button.
 *
 * Middleware already gates /api/admin/* to role=admin.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  try {
    const missing = await findAppointmentsMissingFromSheet()
    // Bucket counts by reason so the UI can show "X never-synced,
    // Y sync-failed, Z sheet-row-missing" without iterating again.
    const counts = {
      total: missing.length,
      neverSynced: missing.filter((m) => m.reason === 'never-synced').length,
      syncFailed: missing.filter((m) => m.reason === 'sync-failed').length,
      sheetRowMissing: missing.filter((m) => m.reason === 'sheet-row-missing')
        .length,
    }
    return NextResponse.json({
      counts,
      // Cap the inline sample at 25 so the response stays small
      // even when the gap is huge (rare but possible after a long
      // outage). Reconcile-all still operates on the full list.
      sample: missing.slice(0, 25),
    })
  } catch (err) {
    console.error('[sheets missing-from-sheet] failed:', err)
    const message = err instanceof Error ? err.message : 'lookup failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
