import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { migrateAddAgentColumns } from '@/lib/drive'

/**
 * POST /api/admin/sheets/migrate-agent-columns
 *
 * One-off admin-only migration: appends "Agent Name" and "Agent Email"
 * header columns to every tab in the master appointments spreadsheet
 * that doesn't already have them. Without these columns the rollup
 * writer drops agent info on Hub-booked appointments — meaning when
 * the call center starts using the in-app CRM we'd lose track of who
 * booked what in the master sheet.
 *
 * Idempotent — safe to run multiple times.
 */
export async function POST() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  // Middleware already gates /api/admin/* to role=admin, so we can trust the
  // session here.
  try {
    const result = await migrateAddAgentColumns()
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.error('[sheets migrate-agent-columns] failed:', err)
    const message = err instanceof Error ? err.message : 'Migration failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
