import { NextRequest } from 'next/server'
import { externalOptions } from '@/lib/external-api'
import { externalWrite, WriteError } from '@/lib/external-write'
import { updateAppointmentStatus } from '@/lib/ghl'
import { clearStaffBookingsCache } from '@/lib/staff-bookings-cache'

/**
 * PATCH /api/external/v1/staff-bookings/attendance
 * { subAccount, appointmentId, status: 'showed' | 'noshow' | 'unmarked' }
 *
 * Marks a booking showed or not from the CRM, writing straight to the
 * GHL appointment. There is no separate record here — the CRM and GHL
 * read and write the same field, so marking it in either place is the
 * same act and they can't disagree.
 *
 * Not owner-gated: Staff Bookings is a staff surface, and the people who
 * ran the call are exactly the ones who know whether it happened.
 */

/**
 * GHL has no null outcome, so "not marked" is expressed as `confirmed`
 * — booked, no outcome recorded — which is what undoing a mistaken mark
 * should leave behind rather than inventing a third state.
 */
const STATUS_MAP = {
  showed: 'showed',
  noshow: 'noshow',
  unmarked: 'confirmed',
} as const

type Incoming = keyof typeof STATUS_MAP

export const PATCH = externalWrite(async ({ body }) => {
  const subAccount = String(body.subAccount ?? '').trim()
  const appointmentId = String(body.appointmentId ?? '').trim()
  const status = String(body.status ?? '').trim() as Incoming

  if (!subAccount) throw new WriteError('subAccount is required')
  if (!appointmentId) {
    throw new WriteError(
      'This booking has no calendar appointment linked, so there is nothing to mark.',
      409,
    )
  }
  if (!(status in STATUS_MAP)) {
    throw new WriteError("status must be 'showed', 'noshow' or 'unmarked'")
  }

  try {
    await updateAppointmentStatus(
      subAccount,
      appointmentId,
      STATUS_MAP[status],
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'GoHighLevel rejected it.'
    throw new WriteError(`Could not update the appointment: ${msg}`, 502)
  }

  // The read caches for a minute. Without this the row would snap back to
  // its old value on the next refetch and look like the write failed.
  clearStaffBookingsCache()

  return { appointmentId, status }
})

export function OPTIONS(req: NextRequest) {
  return externalOptions(req)
}
