/**
 * Appointment conflict detection.
 *
 * Two appointments "conflict" when their time windows overlap. We don't
 * store per-appointment durations, so we assume a uniform DEFAULT_DURATION
 * (solar consults typically run 60-90 minutes). An appointment at 2:00
 * overlaps anything booked between 1:00 and 3:00.
 *
 * Conflicts are scoped to a single client. Each Genisys client has its
 * own closer / pipeline / calendar, so a 1pm booking for Spring Solar
 * (UT) does not collide with a 2pm booking for Brighton (AZ) — they go
 * to different closers. We only look for other bookings under the same
 * clientId. Cancelled appointments are excluded since they free up the
 * slot.
 *
 * Editing an existing appointment passes its id as excludeId so it doesn't
 * flag itself.
 */
import { prisma } from './prisma'
import type { Prisma } from '@/generated/prisma/client'

/** Default appointment duration in minutes. Tune here if Genisys changes
 *  the standard consult length. */
export const DEFAULT_APPOINTMENT_DURATION_MIN = 60

export type AppointmentConflict = {
  id: string
  apptDateTime: string
  customerName: string
  customerPhone: string
  status: string
  agent: { id: string; name: string | null; email: string }
}

/**
 * Find appointments that overlap with the proposed time slot. Window is
 * computed as [apptDateTime - duration, apptDateTime + duration] because
 * either end can cause an overlap given equal durations.
 */
export async function findConflicts(params: {
  apptDateTime: Date
  /** Client whose calendar we're checking. Required — conflicts are
   *  per-client (see file header). */
  clientId: string
  durationMinutes?: number
  excludeId?: string
  /** Optional transaction client so the conflict check can share a tx with
   *  the subsequent create, shrinking the double-booking race window. */
  tx?: Prisma.TransactionClient
}): Promise<AppointmentConflict[]> {
  const duration = params.durationMinutes ?? DEFAULT_APPOINTMENT_DURATION_MIN
  const target = params.apptDateTime.getTime()
  const windowStart = new Date(target - duration * 60_000)
  const windowEnd = new Date(target + duration * 60_000)

  const client = params.tx ?? prisma
  const rows = await client.appointment.findMany({
    where: {
      ...(params.excludeId ? { id: { not: params.excludeId } } : {}),
      clientId: params.clientId,
      status: { notIn: ['cancelled'] },
      apptDateTime: { gte: windowStart, lte: windowEnd },
    },
    include: {
      agent: { select: { id: true, name: true, email: true } },
    },
    orderBy: { apptDateTime: 'asc' },
  })

  // Exact overlap filter: |newStart - existingStart| < duration means windows
  // of equal size actually overlap. The Prisma query above catches candidates
  // at the window boundaries (gte/lte) which we tighten here.
  return rows
    .filter((r) => Math.abs(r.apptDateTime.getTime() - target) < duration * 60_000)
    .map((r) => ({
      id: r.id,
      apptDateTime: r.apptDateTime.toISOString(),
      customerName: r.customerName,
      customerPhone: r.customerPhone,
      status: r.status,
      agent: r.agent,
    }))
}
