import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { migrateAddSentToClientColumn } from '@/lib/drive'

/**
 * POST /api/admin/sheets/migrate-sent-to-client-column
 *
 * One-off admin migration: appends a "Sent to Client?" header column
 * to every tab in the master spreadsheet that doesn't already have
 * one. Powers the Yes / No / Unassigned select on Master Tracker
 * until the Slack auto-handoff workflow ships.
 *
 * Idempotent — safe to run multiple times.
 */
export async function POST() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  // Middleware already gates /api/admin/* to role=admin.
  try {
    const result = await migrateAddSentToClientColumn()
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.error('[sheets migrate-sent-to-client-column] failed:', err)
    const message = err instanceof Error ? err.message : 'Migration failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
