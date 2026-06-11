import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireStaff } from '@/lib/auth-helpers'

/**
 * GET /api/admin/reminders
 *
 * Paginated list of AppointmentReminder rows for the Settings panel
 * + (eventually) a CRM messages tab. Filters: status, clientId,
 * reminderType. Latest-first by scheduledFor so the page leads with
 * what's about to fire (or just fired).
 */
export async function GET(req: NextRequest) {
  const denial = await requireStaff()
  if (denial) return denial

  const sp = req.nextUrl.searchParams
  const status = sp.get('status') // pending | sent | failed | skipped | cancelled | all
  const clientId = sp.get('clientId')
  const reminderType = sp.get('reminderType')
  const customerName = sp.get('customerName')
  const limit = Math.min(200, Math.max(1, parseInt(sp.get('limit') || '50', 10)))

  const where: Record<string, unknown> = {}
  if (status && status !== 'all') where.status = status
  if (clientId) where.clientId = clientId
  if (reminderType) where.reminderType = reminderType
  // Case-insensitive substring match against the customer-name
  // snapshot. Lets admin look up "what happened with Forrest
  // McMurdo's reminders" by pasting any fragment of the name —
  // first name alone, "Forrest", "mcmurdo", etc. Index isn't on
  // customerName so this is a sequential scan, but the reminder
  // table is small enough (~thousands of rows) that the cost is
  // negligible and adds enormous diagnostic value.
  if (customerName) {
    where.customerName = { contains: customerName, mode: 'insensitive' }
  }

  const reminders = await prisma.appointmentReminder.findMany({
    where,
    // For per-customer lookup we want them in firing order (oldest
    // first) so the timeline reads naturally; otherwise default to
    // most-recent-first for the generic log view.
    orderBy: customerName
      ? { scheduledFor: 'asc' }
      : { scheduledFor: 'desc' },
    take: limit,
    include: {
      client: { select: { id: true, name: true, color: true } },
      // Pull the source appointment so the timeline analysis can
      // compare scheduledFor vs apptDateTime — needed to verify
      // "is this firing at the time it should" without a second
      // round-trip.
      appointment: {
        select: {
          id: true,
          apptDateTime: true,
          customerName: true,
          customerPhone: true,
          status: true,
          createdAt: true,
        },
      },
    },
  })

  // For per-customer lookups, compute a small timing analysis per
  // row so admin can see at a glance whether the firing time
  // actually maps to the appointment time + reminder window. Skip
  // the analysis on the generic log view to keep the response slim.
  if (customerName) {
    const analyzed = reminders.map((r) => {
      const apptMs = r.apptDateTime.getTime()
      const schedMs = r.scheduledFor.getTime()
      const offsetMinutesBeforeAppt = Math.round(
        (apptMs - schedMs) / 60_000,
      )
      // Expected offset for each type — confirmation is "as soon as
      // possible" (effectively now), the rest are window-based.
      const expectedOffsetMinutes: Record<string, string> = {
        confirmation: 'immediate (no offset)',
        '1day': '1440 (24 hours before)',
        '4hr': '240 (4 hours before)',
        '2hr': '120 (2 hours before)',
        '30min': '30 (30 minutes before)',
        start: '0 (at appointment time)',
      }
      return {
        ...r,
        _analysis: {
          offsetMinutesBeforeAppt,
          expectedOffsetMinutes:
            expectedOffsetMinutes[r.reminderType] ?? 'unknown',
          firedOnTime:
            r.status === 'sent' && r.sentAt
              ? `sent ${Math.round(
                  (r.sentAt.getTime() - schedMs) / 60_000,
                )} min after scheduledFor`
              : null,
        },
      }
    })
    return NextResponse.json({ reminders: analyzed })
  }

  return NextResponse.json({ reminders })
}
