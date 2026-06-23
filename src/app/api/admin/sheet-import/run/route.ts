import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import { syncSheetAppointmentsToDb } from '@/lib/sheet-appointment-import'

/**
 * POST /api/admin/sheet-import/run
 *
 * On-demand trigger for the sheet→DB appointment import (otherwise
 * runs every 5 min on the scheduler). Lets admin import sheet-only
 * appointments immediately + see the counts. Idempotent — re-running
 * only ever imports genuinely new sheet rows. Never queues reminders.
 */
async function run() {
  const denial = await requireStaff()
  if (denial) return denial
  const result = await syncSheetAppointmentsToDb()
  return NextResponse.json(
    { ok: true, ...result },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function POST() {
  return run()
}

// GET so admin can trigger it by pasting the URL in a signed-in
// browser tab (the auth cookie rides along) and see the JSON result.
export async function GET() {
  return run()
}
