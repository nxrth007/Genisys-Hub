import { NextResponse } from 'next/server'
import { syncRemindersFromSheet } from '@/lib/reminders'
import { requireStaff } from '@/lib/auth-helpers'

/**
 * POST /api/admin/reminders/sync
 *
 * Manually trigger a reminder sync — reads the master sheet,
 * upserts reminder rows for every active appointment. Useful after
 * (a) running the column migration on the sheet, (b) bulk-typing new
 * appointments, or (c) flipping the master enable on for the first
 * time.
 *
 * Idempotent. The cron tick does the same thing every 5 minutes.
 */
export async function POST() {
  const denial = await requireStaff()
  if (denial) return denial
  try {
    const result = await syncRemindersFromSheet()
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.error('[reminders sync] failed:', err)
    const message = err instanceof Error ? err.message : 'Sync failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
