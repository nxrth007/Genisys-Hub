import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/call-center/leaderboard
 * Staff view — per-agent rollup of both Appointment + EodReport activity
 * in a date window. Use this for ranking top performers.
 *
 * Query params:
 *   range   — 7d | 30d | 90d | all | custom (default 30d)
 *   since   — ISO date (only when range=custom)
 *   until   — ISO date (only when range=custom)
 *   client  — restrict appointment stats to a Genisys client id
 *             (EOD numbers are per-shift, not per-client, so they are
 *              unaffected — documented in the payload)
 *
 * Middleware already blocks role=agent from reaching /api/call-center/*.
 */

type Range = '7d' | '30d' | '90d' | 'all' | 'custom'

function parseMoney(raw: string | null): number {
  if (!raw) return 0
  const n = Number(raw.replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}

function daysAgo(n: number): Date {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() - n + 1) // inclusive of today → n-day window
  return d
}

function parseIsoDate(raw: string | null): Date | null {
  if (!raw) return null
  const d = new Date(raw)
  return isNaN(d.getTime()) ? null : d
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null
  return Math.round((numerator / denominator) * 100)
}

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const sp = req.nextUrl.searchParams
  const range = (sp.get('range') || '30d') as Range

  // Resolve date window from the selected range.
  let since: Date | null = null
  let until: Date = new Date()
  if (range === '7d') since = daysAgo(7)
  else if (range === '30d') since = daysAgo(30)
  else if (range === '90d') since = daysAgo(90)
  else if (range === 'custom') {
    since = parseIsoDate(sp.get('since'))
    const parsedUntil = parseIsoDate(sp.get('until'))
    if (parsedUntil) until = parsedUntil
  } else {
    since = null // 'all'
  }

  const clientFilter = sp.get('client')

  // Seed the ranking with every approved agent so those with zero activity
  // still show up (rank last, but visible so Ethan can see who's silent).
  const agents = await prisma.user.findMany({
    where: { role: 'agent' },
    select: { id: true, name: true, email: true },
  })

  // Appointments — filtered by createdAt so we measure "bookings generated
  // in this window" rather than "bookings scheduled in this window".
  const apptWhere: Record<string, unknown> = {}
  if (since) apptWhere.createdAt = { gte: since, lte: until }
  if (clientFilter && clientFilter !== 'all') {
    apptWhere.clientId = clientFilter === 'none' ? null : clientFilter
  }
  const appointments = await prisma.appointment.findMany({
    where: apptWhere,
    select: {
      agentUserId: true,
      status: true,
      estimatedDealValue: true,
    },
  })

  // EOD reports — filtered by reportDate. Not affected by client filter
  // because reports are per-shift, cross-client.
  const eodWhere: Record<string, unknown> = {}
  if (since) eodWhere.reportDate = { gte: since, lte: until }
  const eodReports = await prisma.eodReport.findMany({
    where: eodWhere,
    select: {
      agentUserId: true,
      reportDate: true,
      dialsMade: true,
      contactsReached: true,
      appointmentsGenerated: true,
      callbacksScheduled: true,
    },
  })

  // Build per-agent rows.
  const rows = agents.map((agent) => {
    const myAppts = appointments.filter((a) => a.agentUserId === agent.id)
    const myEods = eodReports.filter((e) => e.agentUserId === agent.id)

    let total = 0
    let booked = 0
    let showed = 0
    let noShow = 0
    let cancelled = 0
    let rescheduled = 0
    let pipelineDollars = 0
    for (const a of myAppts) {
      total++
      if (a.status === 'booked') booked++
      if (a.status === 'showed') showed++
      if (a.status === 'no_show') noShow++
      if (a.status === 'cancelled') cancelled++
      if (a.status === 'rescheduled') rescheduled++
      if (a.status !== 'cancelled' && a.status !== 'no_show') {
        pipelineDollars += parseMoney(a.estimatedDealValue)
      }
    }
    const completed = showed + noShow
    const showRate = rate(showed, completed)

    let dials = 0
    let contacts = 0
    let apptsReported = 0
    let callbacks = 0
    for (const r of myEods) {
      dials += r.dialsMade
      contacts += r.contactsReached
      apptsReported += r.appointmentsGenerated
      callbacks += r.callbacksScheduled
    }
    const connectRate = rate(contacts, dials)
    const bookingRate = rate(apptsReported, contacts)
    const daysReported = myEods.length

    return {
      agent,
      appointments: {
        total,
        booked,
        showed,
        noShow,
        cancelled,
        rescheduled,
        showRate,
        pipelineDollars,
      },
      activity: {
        dials,
        contacts,
        apptsReported,
        callbacks,
        connectRate,
        bookingRate,
        daysReported,
      },
    }
  })

  return NextResponse.json({
    rows,
    range,
    since: since ? since.toISOString() : null,
    until: until.toISOString(),
    clientFilter: clientFilter || 'all',
  })
}
