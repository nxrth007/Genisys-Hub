import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { externalOptions } from '@/lib/external-api'
import { externalWrite, WriteError } from '@/lib/external-write'
import { updateAppointmentStatus } from '@/lib/ghl'
import { clearStaffBookingsCache } from '@/lib/staff-bookings-cache'

/**
 * PATCH /api/external/v1/staff-bookings/attendance
 * { opportunityId, subAccount, status, appointmentId? }
 *
 * Records whether a booking showed.
 *
 * Keyed by OPPORTUNITY, not by appointment. An earlier version wrote
 * only to the GHL calendar appointment, which meant any booking whose
 * contact couldn't be matched to a calendar event had nothing to write
 * to and simply wasn't editable — which was most of them.
 *
 * Where an appointment IS linked, the same value is mirrored into GHL so
 * anyone working there sees it too. That mirror is best-effort: if GHL
 * refuses, the mark is still saved here and the caller is told the
 * mirror failed, rather than losing the edit over a secondary write.
 *
 * Not owner-gated: the people who ran the call know whether it happened.
 */

const ALLOWED = new Set(['showed', 'noshow', 'unmarked'])

/** GHL has no null outcome; `confirmed` means booked, no outcome recorded. */
const GHL_STATUS = {
  showed: 'showed',
  noshow: 'noshow',
  unmarked: 'confirmed',
} as const

export const PATCH = externalWrite(async ({ auth, body }) => {
  const opportunityId = String(body.opportunityId ?? '').trim()
  const subAccount = String(body.subAccount ?? '').trim()
  const status = String(body.status ?? '').trim()
  const appointmentId = String(body.appointmentId ?? '').trim()

  if (!opportunityId) throw new WriteError('opportunityId is required')
  if (!subAccount) throw new WriteError('subAccount is required')
  if (!ALLOWED.has(status)) {
    throw new WriteError("status must be 'showed', 'noshow' or 'unmarked'")
  }

  await prisma.bookingAttendance.upsert({
    where: { opportunityId },
    create: {
      opportunityId,
      subAccount,
      status,
      markedById: auth.user.id,
    },
    update: { status, markedById: auth.user.id, subAccount },
  })

  // Mirror into GHL when there's an appointment to carry it. Deliberately
  // after the local write and deliberately non-fatal.
  let mirrored: boolean | null = null
  if (appointmentId) {
    try {
      await updateAppointmentStatus(
        subAccount,
        appointmentId,
        GHL_STATUS[status as keyof typeof GHL_STATUS],
      )
      mirrored = true
    } catch {
      mirrored = false
    }
  }

  clearStaffBookingsCache()

  return { opportunityId, status, mirroredToGhl: mirrored }
})

export function OPTIONS(req: NextRequest) {
  return externalOptions(req)
}
