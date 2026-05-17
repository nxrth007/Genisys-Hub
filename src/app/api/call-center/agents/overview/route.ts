import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/call-center/agents/overview
 *
 * Agent-first roster + per-agent operational signals for the Call
 * Center → Agents tab. Replaces the previous /by-pod endpoint, which
 * grouped each agent under their single "primary" client — wrong for
 * Genisys, where a single agent (Mary today, more eventually) books
 * for every client. The old shape was hiding most of Mary's work.
 *
 * Query params:
 *   range       — '7d' | '30d' | '90d' | 'all'   (default '30d')
 *   client      — Client.id | 'all'              (default 'all')
 *   activeOnly  — 'true' | 'false'               (default 'true')
 *
 * "Active" = approvedAt != null AND has at least one signal
 * (appointment, EOD report, callback) within the last 60 days. Test /
 * dormant accounts are hidden by default so live metrics don't get
 * diluted; the page exposes a toggle to bring them back.
 *
 * Staff-only — middleware blocks role=agent from /api/call-center/*.
 */

type Range = '7d' | '30d' | '90d' | 'all'

/** Emails always excluded from the roster. Per Alex (2026-05-17):
 *  Mary's dummy/test login lives here so it doesn't pollute metrics
 *  even when activeOnly=false. Add more on request — fine as a
 *  hardcoded denylist until we have enough that an admin UI earns
 *  its keep. */
const EXCLUDED_AGENT_EMAILS: ReadonlySet<string> = new Set([
  'razyaim@gmail.com',
])

/** How recently an agent must have done *something* (book, EOD, or
 *  callback) to count as "active" for the default filter. Picked at
 *  60d so genuine call-center agents who took a vacation don't get
 *  hidden but a long-abandoned test account does. */
const ACTIVE_RECENCY_DAYS = 60

function daysAgoUtc(n: number): Date {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() - n + 1) // inclusive of today → n-day window
  return d
}

function parseMoney(raw: string | null): number {
  if (!raw) return 0
  const n = Number(raw.replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null
  return Math.round((numerator / denominator) * 100)
}

function isSameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  )
}

/** Count weekdays (Mon-Fri UTC) in the half-open interval [start, end).
 *  Used as the "expected EOD reports" denominator — a rough proxy for
 *  shift days when we don't track actual schedules. Documented in the
 *  payload so the UI can label it accordingly. */
function weekdaysBetween(start: Date, end: Date): number {
  let count = 0
  const cursor = new Date(start)
  cursor.setUTCHours(0, 0, 0, 0)
  const stop = new Date(end)
  stop.setUTCHours(0, 0, 0, 0)
  while (cursor < stop) {
    const day = cursor.getUTCDay() // 0=Sun, 6=Sat
    if (day !== 0 && day !== 6) count++
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return count
}

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const sp = req.nextUrl.searchParams
  const range = (sp.get('range') || '30d') as Range
  const clientFilter = sp.get('client') || 'all'
  const activeOnly = (sp.get('activeOnly') ?? 'true') !== 'false'

  // Resolve the window. We also compute a "prior" window of the same
  // length immediately before `since` so the header can show WoW /
  // MoM deltas without a second round-trip.
  const now = new Date()
  let since: Date | null
  let windowDays: number
  if (range === '7d') {
    since = daysAgoUtc(7)
    windowDays = 7
  } else if (range === '90d') {
    since = daysAgoUtc(90)
    windowDays = 90
  } else if (range === 'all') {
    since = null
    windowDays = 0 // sentinel — prior-window math skipped below
  } else {
    since = daysAgoUtc(30)
    windowDays = 30
  }
  const priorSince =
    since && windowDays > 0
      ? new Date(since.getTime() - windowDays * 24 * 60 * 60 * 1000)
      : null
  const priorUntil = since

  // Roster. We pull every approved agent and then optionally filter
  // for recency at the end — letting the activeOnly=false caller see
  // everyone in one query.
  const agents = await prisma.user.findMany({
    where: { role: 'agent', approvedAt: { not: null } },
    select: {
      id: true,
      name: true,
      email: true,
      approvedAt: true,
      agentSheetTab: true,
      createdAt: true,
    },
    orderBy: [{ name: 'asc' }, { email: 'asc' }],
  })
  const rosterIds = agents
    .filter((a) => !EXCLUDED_AGENT_EMAILS.has(a.email.toLowerCase()))
    .map((a) => a.id)
  const visibleAgents = agents.filter((a) => rosterIds.includes(a.id))

  // Clients — drives the filter chips + per-client breakdown bar.
  type ClientLite = {
    id: string
    name: string
    state: string | null
    color: string
  }
  const clients: ClientLite[] = await prisma.client.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, state: true, color: true },
  })
  const clientById: Map<string, ClientLite> = new Map(
    clients.map((c: ClientLite) => [c.id, c]),
  )

  // Appointments in the active window. We also load a tiny "any time"
  // query per-agent for last-activity-at and the active-recency check;
  // see below. The clientId filter applies to appointment stats only
  // (EOD reports aren't per-client by design — they're per-shift).
  const apptWhere: Record<string, unknown> = { agentUserId: { in: rosterIds } }
  if (since) apptWhere.createdAt = { gte: since }
  if (clientFilter && clientFilter !== 'all') {
    apptWhere.clientId = clientFilter
  }
  const appointments = await prisma.appointment.findMany({
    where: apptWhere,
    select: {
      agentUserId: true,
      clientId: true,
      status: true,
      apptDateTime: true,
      createdAt: true,
      estimatedDealValue: true,
    },
  })

  // Prior-window appointments — same filters, just shifted back so
  // the header can show "X bookings, +Y vs. last <window>". Skipped
  // when range=all (no meaningful prior to compare against).
  const priorAppointments =
    priorSince && priorUntil
      ? await prisma.appointment.findMany({
          where: {
            agentUserId: { in: rosterIds },
            createdAt: { gte: priorSince, lt: priorUntil },
            ...(clientFilter !== 'all' ? { clientId: clientFilter } : {}),
          },
          select: { id: true, agentUserId: true },
        })
      : []

  // EOD reports in the active window. Not affected by clientFilter
  // (reports are per-shift, cross-client).
  const eodReports = await prisma.eodReport.findMany({
    where: {
      agentUserId: { in: rosterIds },
      ...(since ? { reportDate: { gte: since } } : {}),
    },
    select: {
      agentUserId: true,
      reportDate: true,
      dialsMade: true,
      contactsReached: true,
      appointmentsGenerated: true,
      callbacksScheduled: true,
    },
  })

  // Callbacks in the active window. Mostly for the recency check
  // (counts toward "active" status) and a small footer count.
  const callbacks = await prisma.callback.findMany({
    where: {
      agentUserId: { in: rosterIds },
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    select: { agentUserId: true, createdAt: true, completedAt: true },
  })

  // Recency lookup — "last time this agent did *anything*". One small
  // findFirst per agent per signal stream; the roster is small enough
  // (single-digit agents) that this is fine and beats hand-rolling a
  // groupBy. If the roster grows past ~50 we can flip to a raw SQL
  // unionMax.
  const recencyCutoff = new Date(
    Date.now() - ACTIVE_RECENCY_DAYS * 24 * 60 * 60 * 1000,
  )
  const lastActivityByAgent = new Map<string, Date | null>()
  await Promise.all(
    rosterIds.map(async (id) => {
      const [lastAppt, lastEod, lastCallback] = await Promise.all([
        prisma.appointment.findFirst({
          where: { agentUserId: id },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
        prisma.eodReport.findFirst({
          where: { agentUserId: id },
          orderBy: { reportDate: 'desc' },
          select: { reportDate: true },
        }),
        prisma.callback.findFirst({
          where: { agentUserId: id },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
      ])
      const candidates = [
        lastAppt?.createdAt ?? null,
        lastEod?.reportDate ?? null,
        lastCallback?.createdAt ?? null,
      ].filter((d): d is Date => d !== null)
      lastActivityByAgent.set(
        id,
        candidates.length
          ? candidates.reduce((a, b) => (a > b ? a : b))
          : null,
      )
    }),
  )

  // Per-agent rollups.
  const trendBuckets = windowDays > 0 ? windowDays : 30
  const trendStart = daysAgoUtc(trendBuckets)
  const rows = visibleAgents.map((agent) => {
    const myAppts = appointments.filter((a) => a.agentUserId === agent.id)
    const myEods = eodReports.filter((e) => e.agentUserId === agent.id)
    const myCallbacks = callbacks.filter((c) => c.agentUserId === agent.id)
    const lastActivityAt = lastActivityByAgent.get(agent.id) ?? null

    // Status buckets — won/lost roll into "showed" the same way the
    // existing agent detail page does so closing a deal doesn't drop
    // show-rate.
    let total = 0
    let booked = 0
    let rescheduled = 0
    let showed = 0
    let noShow = 0
    let cancelled = 0
    let pipelineDollars = 0
    let upcoming = 0
    const perClientMap = new Map<string, { count: number; showed: number; noShow: number }>()
    const nowMs = now.getTime()
    for (const a of myAppts) {
      total++
      switch (a.status) {
        case 'booked':
          booked++
          break
        case 'rescheduled':
          rescheduled++
          break
        case 'showed':
        case 'won':
        case 'lost':
          showed++
          break
        case 'no_show':
          noShow++
          break
        case 'cancelled':
          cancelled++
          break
      }
      if (a.apptDateTime.getTime() > nowMs && a.status !== 'cancelled') {
        upcoming++
      }
      // Pipeline = open deals only — same definition as the
      // leaderboard. Cancelled / no-show / lost are excluded.
      if (
        a.status === 'booked' ||
        a.status === 'rescheduled' ||
        a.status === 'showed' ||
        a.status === 'won'
      ) {
        pipelineDollars += parseMoney(a.estimatedDealValue)
      }
      if (a.clientId) {
        const slot =
          perClientMap.get(a.clientId) ??
          { count: 0, showed: 0, noShow: 0 }
        slot.count++
        if (a.status === 'showed' || a.status === 'won' || a.status === 'lost')
          slot.showed++
        if (a.status === 'no_show') slot.noShow++
        perClientMap.set(a.clientId, slot)
      }
    }
    const completed = showed + noShow
    const showRate = rate(showed, completed)

    // Per-client breakdown — sorted desc by count so the biggest
    // segment is first on the stacked bar.
    const perClient = Array.from(perClientMap.entries())
      .map(([clientId, slot]) => {
        const client = clientById.get(clientId)
        return {
          clientId,
          clientName: client?.name ?? 'Unknown client',
          clientColor: client?.color ?? '#6b7280',
          count: slot.count,
          showRate: rate(slot.showed, slot.showed + slot.noShow),
        }
      })
      .sort((a, b) => b.count - a.count)

    // EOD aggregates.
    let dials = 0
    let contacts = 0
    let apptsReported = 0
    let eodCallbacks = 0
    for (const r of myEods) {
      dials += r.dialsMade
      contacts += r.contactsReached
      apptsReported += r.appointmentsGenerated
      eodCallbacks += r.callbacksScheduled
    }
    const connectRate = rate(contacts, dials)
    const bookingRate = rate(apptsReported, contacts)
    const daysReported = myEods.length
    // "Expected days" — weekdays in the active window after the agent
    // was approved (you can't expect a report from before they
    // existed). Approximation, documented in the response. Skipped
    // for range=all.
    let expectedDays: number | null = null
    let missingDays: number | null = null
    if (since && agent.approvedAt) {
      const effectiveStart =
        agent.approvedAt > since ? agent.approvedAt : since
      expectedDays = weekdaysBetween(effectiveStart, now)
      missingDays = Math.max(0, expectedDays - daysReported)
    }

    // 30-bucket daily trend — fixed at 30 buckets when window=all,
    // otherwise mirrors the active window length.
    const buckets: Array<{ date: string; count: number }> = []
    for (let i = 0; i < trendBuckets; i++) {
      const d = new Date(trendStart)
      d.setUTCDate(trendStart.getUTCDate() + i)
      buckets.push({ date: d.toISOString().slice(0, 10), count: 0 })
    }
    for (const a of myAppts) {
      const created = new Date(a.createdAt)
      created.setUTCHours(0, 0, 0, 0)
      for (const b of buckets) {
        const bDate = new Date(b.date + 'T00:00:00Z')
        if (isSameUtcDay(created, bDate)) {
          b.count++
          break
        }
      }
    }

    // Status badge classification — drives the colored chip on each
    // agent card. Cutoffs picked to surface "should I be worried?"
    // signals: 0-2d = active, 3-7d = quiet, 8-30d = stale, >30d =
    // dormant. We don't try to be smarter here (e.g. weekday-aware) —
    // the page should make a "Mary went quiet Friday and it's
    // Tuesday now" jump out.
    let activityStatus: 'active' | 'quiet' | 'stale' | 'dormant' | 'never'
    if (!lastActivityAt) activityStatus = 'never'
    else {
      const ageDays =
        (Date.now() - lastActivityAt.getTime()) / (24 * 60 * 60 * 1000)
      if (ageDays < 3) activityStatus = 'active'
      else if (ageDays < 8) activityStatus = 'quiet'
      else if (ageDays < 31) activityStatus = 'stale'
      else activityStatus = 'dormant'
    }

    return {
      id: agent.id,
      name: agent.name,
      email: agent.email,
      approvedAt: agent.approvedAt ? agent.approvedAt.toISOString() : null,
      agentSheetTab: agent.agentSheetTab,
      lastActivityAt: lastActivityAt ? lastActivityAt.toISOString() : null,
      activityStatus,
      bookings: {
        total,
        booked,
        rescheduled,
        showed,
        noShow,
        cancelled,
        upcoming,
        showRate,
        pipelineDollars,
      },
      activity: {
        dials,
        contacts,
        apptsReported,
        callbacks: eodCallbacks,
        callbacksOpen: myCallbacks.filter((c) => !c.completedAt).length,
        connectRate,
        bookingRate,
        daysReported,
        expectedDays,
        missingDays,
      },
      perClient,
      trend: buckets,
    }
  })

  // Apply the active filter last so the summary tiles can still
  // include the totals across the dimmed rows when the user toggles
  // it off (they expect the numbers to update accordingly).
  const filteredRows = activeOnly
    ? rows.filter(
        (r) =>
          r.lastActivityAt && new Date(r.lastActivityAt) >= recencyCutoff,
      )
    : rows

  // Summary tiles — header strip metrics. Computed AFTER the row
  // pass so we can reuse the same totals (cheap and ensures they
  // line up exactly with what's drawn below).
  const totalBookingsThisWindow = filteredRows.reduce(
    (s, r) => s + r.bookings.total,
    0,
  )
  const totalBookingsPriorWindow = priorAppointments.length
  const totalPipeline = filteredRows.reduce(
    (s, r) => s + r.bookings.pipelineDollars,
    0,
  )
  const allShowed = filteredRows.reduce((s, r) => s + r.bookings.showed, 0)
  const allNoShow = filteredRows.reduce((s, r) => s + r.bookings.noShow, 0)
  const avgShowRate = rate(allShowed, allShowed + allNoShow)
  const totalDaysReported = filteredRows.reduce(
    (s, r) => s + r.activity.daysReported,
    0,
  )
  const totalDaysExpected = filteredRows.reduce(
    (s, r) => s + (r.activity.expectedDays ?? 0),
    0,
  )
  const eodConsistency = rate(totalDaysReported, totalDaysExpected)
  const activeThisWindow = filteredRows.filter(
    (r) =>
      r.activityStatus === 'active' ||
      r.activityStatus === 'quiet' ||
      r.bookings.total > 0 ||
      r.activity.daysReported > 0,
  ).length

  return NextResponse.json({
    range,
    since: since ? since.toISOString() : null,
    until: now.toISOString(),
    clientFilter,
    activeOnly,
    excludedHidden: agents.length - visibleAgents.length,
    summary: {
      activeAgents: activeThisWindow,
      totalAgents: filteredRows.length,
      bookingsThisWindow: totalBookingsThisWindow,
      bookingsPriorWindow: totalBookingsPriorWindow,
      bookingsDelta:
        priorSince !== null
          ? totalBookingsThisWindow - totalBookingsPriorWindow
          : null,
      pipelineDollars: totalPipeline,
      avgShowRate,
      eodConsistency,
    },
    agents: filteredRows,
    clients,
  })
}
