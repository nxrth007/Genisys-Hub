import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { signRecordingUrl } from '@/lib/recording-proxy'
import { getPublicOrigin } from '@/lib/gmail'

/**
 * GET /api/client/appointments
 *
 * Returns every appointment booked for the logged-in client. Read-only
 * — clients can see what we've delivered to them, but can't edit, mark
 * showed/no-show, or otherwise mutate state. That stays admin/agent.
 *
 * Filter is server-side on session.user.clientId so a tampered query
 * string can't leak another client's pipeline. Middleware already
 * blocks non-client_active roles before this handler runs; the
 * defensive checks here are belt-and-suspenders for future regressions.
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (session.user.role !== 'client_active') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const clientId = session.user.clientId
  if (!clientId) {
    // A client_active user with no clientId is a misconfigured row —
    // don't leak everyone's appointments by returning an unfiltered
    // list. Empty result + a hint lets admin spot the issue quickly.
    return NextResponse.json({
      appointments: [],
      client: null,
      warning: 'no client linked to this account',
    })
  }

  const [client, appointments] = await Promise.all([
    prisma.client.findUnique({
      where: { id: clientId },
      select: {
        id: true,
        name: true,
        state: true,
        color: true,
        package: true,
        apptCap: true,
      },
    }),
    prisma.appointment.findMany({
      where: { clientId },
      orderBy: { apptDateTime: 'desc' },
      select: {
        id: true,
        apptDateTime: true,
        customerName: true,
        customerPhone: true,
        address: true,
        email: true,
        monthlyBill: true,
        utilityProvider: true,
        roofType: true,
        roofAge: true,
        status: true,
        estimatedDealValue: true,
        notes: true,
        bookedByName: true,
        // Client-side status update fields. Surfaced so the
        // dashboard "Update Status" modal can pre-fill the notes
        // textarea on re-open and show "Last updated X ago" hints.
        clientNotes: true,
        clientStatusUpdatedAt: true,
        // Pre-fill source for the "Customer Disqualified?"
        // follow-up question in the status-report modal. Null when
        // the client hasn't answered yet.
        customerDisqualified: true,
        createdAt: true,
        // Raw vicitel URL — IP-gated, so we never ship it to the
        // client directly. signRecordingUrl wraps it in a signed Hub
        // proxy URL that anyone can play; we only return that wrapped
        // URL in the response below.
        callRecordingLink: true,
      },
    }),
  ])

  // Wrap each appointment's raw recording URL in a signed proxy URL
  // before sending it to the browser. signRecordingUrl returns null
  // when RECORDING_PROXY_SECRET isn't set OR the upstream host isn't
  // on the allowlist — in either case we drop the field entirely so
  // the UI doesn't render a broken Listen link. Strip the raw URL on
  // the way out either way; the client never sees the vicitel host.
  const hubOrigin = getPublicOrigin(req)
  const appointmentsForClient = appointments.map((a: typeof appointments[number]) => {
    const { callRecordingLink, ...rest } = a
    const signed = callRecordingLink?.trim()
      ? signRecordingUrl(callRecordingLink.trim(), hubOrigin)
      : null
    return { ...rest, recordingUrl: signed }
  })

  return NextResponse.json({ client, appointments: appointmentsForClient })
}
