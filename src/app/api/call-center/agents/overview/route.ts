import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { readAllSheetRows } from '@/lib/secondary-sheets'
import { buildRoutingIndex, routeRowToClient } from '@/lib/client-routing'
import { normalizeAddress } from '@/lib/address'

/**
 * GET /api/call-center/agents/overview
 *
 * Agent-first roster + per-agent operational signals for the Call
 * Center → Agents tab.
 *
 * Source-of-truth: the Master Tracker (the Google Sheet, read via
 * readAllSheetRows). Same canonical view the /master-tracker page
 * uses, so the counts on this page can never diverge from what
 * admin sees on the tracker itself. Previous DB-only implementation
 * undercounted because rows entered directly into the sheet (manual
 * entries, sync gaps) never had a corresponding Appointment row.
 *
 * Attribution (per sheet row):
 *   1. row.agentEmail → roster agent by exact email match
 *   2. fall back to DB Appointment.agentUserId via masterSheetRowNumber
 *      or (phone + apptDateTime) content key — catches Hub-form
 *      bookings where the sheet's agentEmail column wasn't backfilled
 *   3. PRIMARY SHEET sole-agent fallback: if exactly one approved Hub
 *      agent exists (Mary, today), every primary-sheet row that
 *      wasn't matched by (1) or (2) attributes to her. Scoped to the
 *      primary sheet only — secondary partner sheets (Yassin's team)
 *      are NOT Mary's even when their agent column is blank, so they
 *      keep falling through. This rule self-disables the moment a
 *      second agent onboards — at that point the banner reappears
 *      and we surface the data gap instead of guessing.
 *   4. otherwise: counted as "unattributed sheet rows" and surfaced
 *      to the UI as a data-quality banner
 *
 * EOD reports + callbacks are still DB-only (they're Hub-native, never
 * touched the sheet), and we include them in the "last activity"
 * recency calculation that drives each agent's status badge.
 *
 * Query params:
 *   range       — '7d' | '30d' | '90d' | 'all'   (default '30d')
 *   client      — Client.id | 'all'              (default 'all')
 *   activeOnly  — 'true' | 'false'               (default 'true')
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
 *  callback) to count as "active" for the default filter. */
const ACTIVE_RECENCY_DAYS = 60

function daysAgoUtc(n: number): Date {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() - n + 1)
  return d
}

function parseMoney(raw: string | null | undefined): number {
  if (!raw) return 0
  const n = Number(String(raw).replace(/[^0-9.-]/g, ''))
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

/** Count weeks in the half-open interval [start, end). Used as the
 *  "expected EOW reports" denominator — one report per calendar week.
 *  Any partial week counts as 1 (an agent active for any part of a
 *  week is expected to file a report for it). The math is ceil of
 *  ms / week, floored at 1 when start < end. */
function weeksBetween(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime()
  if (ms <= 0) return 0
  return Math.max(1, Math.ceil(ms / (7 * 24 * 60 * 60 * 1000)))
}

function normalizePhoneForKey(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = String(raw).replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length >= 10) return `+${digits}`
  return null
}

/** Sheet's `status` column is free-text — normalize into the same
 *  tokens the master tracker UI uses so show-rate math stays
 *  consistent across pages. Mirrors the helper in
 *  /api/call-center/master-tracker; duplicated here to keep this
 *  route self-contained. */
function normalizeStatus(raw: string | null | undefined): string {
  if (!raw) return 'booked'
  const s = String(raw).toLowerCase().trim()
  if (s === 'no show' || s === 'no-show' || s === 'noshow') return 'no_show'
  if (s === 'rescheduled' || s === 'reschedule') return 'rescheduled'
  if (s === 'showed' || s === 'show' || s === 'shown') return 'showed'
  if (s === 'cancelled' || s === 'canceled' || s === 'cancel') return 'cancelled'
  if (s === 'won' || s === 'closed' || s === 'sold' || s === 'win') return 'won'
  if (s === 'lost' || s === 'no sale' || s === 'no-sale' || s === 'loss') return 'lost'
  return 'booked'
}

/** Best-available timestamp for "when this row was logged." Used
 *  for window filtering, prior-window delta, trend buckets, and the
 *  per-agent last-activity calc. Sheet's loggedAt column wins;
 *  falls through to DB createdAt when matched; then apptDateTime;
 *  then null (row gets dropped from windowed views). */
function bestLoggedAt(
  row: { loggedAt: string | null; apptDateTime: string | null },
  dbCreatedAt: Date | null,
): Date | null {
  if (row.loggedAt) {
    const d = new Date(row.loggedAt)
    if (!isNaN(d.getTime())) return d
  }
  if (dbCreatedAt) return dbCreatedAt
  if (row.apptDateTime) {
    const d = new Date(row.apptDateTime)
    if (!isNaN(d.getTime())) return d
  }
  return null
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
    windowDays = 0
  } else {
    since = daysAgoUtc(30)
    windowDays = 30
  }
  const priorSince =
    since && windowDays > 0
      ? new Date(since.getTime() - windowDays * 24 * 60 * 60 * 1000)
      : null
  const priorUntil = since

  // Roster — every approved Hub agent. We post-filter test/dummy
  // accounts so they never inflate counters even if activeOnly=false.
  const agentsRaw = await prisma.user.findMany({
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
  type AgentLite = (typeof agentsRaw)[number]
  const agents: AgentLite[] = agentsRaw.filter(
    (a) => !EXCLUDED_AGENT_EMAILS.has(a.email.toLowerCase()),
  )
  const rosterIds = agents.map((a) => a.id)
  const emailToAgentId = new Map<string, string>(
    agents.map((a) => [a.email.toLowerCase(), a.id]),
  )

  // Clients — filter chips + per-client breakdown.
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
  const routingIndex = buildRoutingIndex(
    clients.map((c) => ({ id: c.id, name: c.name, state: c.state })),
  )

  // Master Tracker (source of truth) + DB appointments in parallel.
  // The sheet read also pulls every secondary sheet so partner-call-
  // center bookings (Yassin's team) are visible — they attribute to
  // whichever email is in that row, which won't match any roster
  // agent and so lands in the "unattributed" bucket. That's exactly
  // what we want until/unless those agents get Hub accounts.
  const [sheetRows, dbAppts, eodReports, callbacks] = await Promise.all([
    readAllSheetRows().catch((err) => {
      console.error('[agents/overview] sheet read failed:', err)
      return [] as Awaited<ReturnType<typeof readAllSheetRows>>
    }),
    prisma.appointment.findMany({
      select: {
        id: true,
        agentUserId: true,
        masterSheetRowNumber: true,
        customerPhone: true,
        apptDateTime: true,
        createdAt: true,
        status: true,
        estimatedDealValue: true,
        clientId: true,
      },
    }),
    prisma.eodReport.findMany({
      where: { agentUserId: { in: rosterIds } },
      select: {
        agentUserId: true,
        reportDate: true,
        dialsMade: true,
        contactsReached: true,
        appointmentsGenerated: true,
        callbacksScheduled: true,
      },
    }),
    prisma.callback.findMany({
      where: { agentUserId: { in: rosterIds } },
      select: { agentUserId: true, createdAt: true, completedAt: true },
    }),
  ])

  // DB index — used for attribution fallback (sheet row → agentUserId
  // via DB match) AND for loggedAt enrichment (sheet's logged-at
  // column is often blank for Hub-synced rows; DB createdAt is
  // authoritative when it exists).
  const dbByRowNumber = new Map<number, (typeof dbAppts)[number]>()
  const dbByContent = new Map<string, (typeof dbAppts)[number]>()
  for (const a of dbAppts) {
    if (a.masterSheetRowNumber) {
      dbByRowNumber.set(a.masterSheetRowNumber, a)
    }
    const phoneKey = normalizePhoneForKey(a.customerPhone)
    if (phoneKey && a.apptDateTime) {
      dbByContent.set(
        `${phoneKey}|${a.apptDateTime.toISOString()}`,
        a,
      )
    }
  }

  type SheetRow = (typeof sheetRows)[number]
  type AttributedRow = {
    row: SheetRow
    dbMatch: (typeof dbAppts)[number] | null
    loggedAt: Date | null
    agentId: string | null
  }

  // Walk every sheet row, resolve attribution + best loggedAt.
  const attributedByAgent = new Map<string, AttributedRow[]>()
  const unattributed: AttributedRow[] = []
  let totalSheetRowsConsidered = 0
  for (const row of sheetRows) {
    if (!row.customerName?.trim()) continue
    totalSheetRowsConsidered++

    // Match the DB appointment for this row (if any). Primary path:
    // masterSheetRowNumber, only meaningful for the primary sheet
    // since secondary rows live in different spreadsheets. Fallback:
    // content key (phone + apptDateTime).
    let dbMatch: (typeof dbAppts)[number] | null = null
    if (row.source.kind === 'primary') {
      dbMatch = dbByRowNumber.get(row.rowNumber) ?? null
    }
    if (!dbMatch && row.customerPhone && row.apptDateTime) {
      const phoneKey = normalizePhoneForKey(row.customerPhone)
      if (phoneKey) {
        const apptDate = new Date(row.apptDateTime)
        if (!isNaN(apptDate.getTime())) {
          dbMatch =
            dbByContent.get(`${phoneKey}|${apptDate.toISOString()}`) ?? null
        }
      }
    }

    // Attribution priority: sheet's own agentEmail → DB row →
    // primary-sheet sole-agent fallback → unattributed.
    let agentId: string | null = null
    if (row.agentEmail) {
      agentId = emailToAgentId.get(row.agentEmail.toLowerCase()) ?? null
    }
    if (!agentId && dbMatch?.agentUserId) {
      // Don't fall back to a DB attribution that points at a hidden
      // (excluded) account — that would smuggle test-account rows
      // back into the counts. Check against the roster.
      if (rosterIds.includes(dbMatch.agentUserId)) {
        agentId = dbMatch.agentUserId
      }
    }
    if (
      !agentId &&
      row.source.kind === 'primary' &&
      agents.length === 1
    ) {
      // Sole-agent fallback. Documented in the file header — only
      // primary-sheet rows, only when one approved Hub agent exists.
      // Yassin's secondary-sheet rows never reach this branch.
      agentId = agents[0]!.id
    }

    const loggedAt = bestLoggedAt(row, dbMatch?.createdAt ?? null)

    const entry: AttributedRow = {
      row,
      dbMatch,
      loggedAt,
      agentId,
    }
    if (agentId) {
      const list = attributedByAgent.get(agentId) ?? []
      list.push(entry)
      attributedByAgent.set(agentId, list)
    } else {
      unattributed.push(entry)
    }
  }

  // Apply window + client filters to a row list. Returns the rows
  // and an "all-time" sub-count for the per-client breakdown
  // (which always shows lifetime to be useful).
  function applyWindow(rows: AttributedRow[]): AttributedRow[] {
    if (!since) return rows
    return rows.filter((r) => r.loggedAt !== null && r.loggedAt >= since)
  }
  function applyClient(rows: AttributedRow[]): AttributedRow[] {
    if (clientFilter === 'all') return rows
    return rows.filter((r) => {
      const route = routeRowToClient(
        {
          client: r.row.client,
          address: normalizeAddress(r.row.address),
        },
        routingIndex,
      )
      if (route.source === 'unrouted') return false
      return route.client.id === clientFilter
    })
  }

  // Trend buckets — fixed at the window length, fallback to 30 for
  // range='all' so the sparkline keeps a meaningful shape.
  const trendBuckets = windowDays > 0 ? windowDays : 30
  const trendStart = daysAgoUtc(trendBuckets)

  const rows = agents.map((agent) => {
    const allMine = attributedByAgent.get(agent.id) ?? []
    const myWindow = applyClient(applyWindow(allMine))
    const myEods = eodReports.filter((e) => e.agentUserId === agent.id)
    const myCallbacks = callbacks.filter((c) => c.agentUserId === agent.id)

    // Last activity across every signal stream (sheet bookings + EOD
    // reports + callbacks). Drives the active/quiet/stale/dormant
    // badge AND the activeOnly filter.
    let lastActivityAt: Date | null = null
    for (const e of allMine) {
      if (e.loggedAt && (!lastActivityAt || e.loggedAt > lastActivityAt)) {
        lastActivityAt = e.loggedAt
      }
    }
    for (const r of myEods) {
      if (!lastActivityAt || r.reportDate > lastActivityAt) {
        lastActivityAt = r.reportDate
      }
    }
    for (const c of myCallbacks) {
      if (!lastActivityAt || c.createdAt > lastActivityAt) {
        lastActivityAt = c.createdAt
      }
    }

    // Booking metrics — computed from sheet status (canonical) with
    // DB enrichment for deal value when the sheet's column is blank.
    let total = 0
    let booked = 0
    let rescheduled = 0
    let showed = 0
    let noShow = 0
    let cancelled = 0
    let pipelineDollars = 0
    let upcoming = 0
    const perClientMap = new Map<
      string,
      { count: number; showed: number; noShow: number }
    >()
    const nowMs = now.getTime()
    for (const entry of myWindow) {
      total++
      const status = normalizeStatus(entry.row.status)
      switch (status) {
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
      const apptDate = entry.row.apptDateTime
        ? new Date(entry.row.apptDateTime)
        : null
      if (
        apptDate &&
        !isNaN(apptDate.getTime()) &&
        apptDate.getTime() > nowMs &&
        status !== 'cancelled'
      ) {
        upcoming++
      }
      if (
        status === 'booked' ||
        status === 'rescheduled' ||
        status === 'showed' ||
        status === 'won'
      ) {
        const deal =
          parseMoney(entry.row.estimatedDealValue) ||
          parseMoney(entry.dbMatch?.estimatedDealValue ?? null)
        pipelineDollars += deal
      }

      // Per-client routing — same brain as the master tracker.
      const route = routeRowToClient(
        {
          client: entry.row.client,
          address: normalizeAddress(entry.row.address),
        },
        routingIndex,
      )
      if (route.source !== 'unrouted') {
        const cid = route.client.id
        const slot =
          perClientMap.get(cid) ?? { count: 0, showed: 0, noShow: 0 }
        slot.count++
        if (status === 'showed' || status === 'won' || status === 'lost')
          slot.showed++
        if (status === 'no_show') slot.noShow++
        perClientMap.set(cid, slot)
      }
    }
    const completed = showed + noShow
    const showRate = rate(showed, completed)

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

    // EOD activity strip — DB-only since EodReport lives in Postgres.
    const myEodsInWindow = since
      ? myEods.filter((e) => e.reportDate >= since)
      : myEods
    let dials = 0
    let contacts = 0
    let apptsReported = 0
    let eodCallbacks = 0
    for (const r of myEodsInWindow) {
      dials += r.dialsMade
      contacts += r.contactsReached
      apptsReported += r.appointmentsGenerated
      eodCallbacks += r.callbacksScheduled
    }
    const connectRate = rate(contacts, dials)
    const bookingRate = rate(apptsReported, contacts)
    const daysReported = myEodsInWindow.length
    let expectedDays: number | null = null
    let missingDays: number | null = null
    if (since && agent.approvedAt) {
      const effectiveStart =
        agent.approvedAt > since ? agent.approvedAt : since
      expectedDays = weeksBetween(effectiveStart, now)
      missingDays = Math.max(0, expectedDays - daysReported)
    }

    // Trend — daily bookings created by loggedAt, bucketed across
    // the window length.
    const buckets: Array<{ date: string; count: number }> = []
    for (let i = 0; i < trendBuckets; i++) {
      const d = new Date(trendStart)
      d.setUTCDate(trendStart.getUTCDate() + i)
      buckets.push({ date: d.toISOString().slice(0, 10), count: 0 })
    }
    for (const entry of allMine) {
      if (!entry.loggedAt) continue
      if (entry.loggedAt < trendStart) continue
      const day = new Date(entry.loggedAt)
      day.setUTCHours(0, 0, 0, 0)
      for (const b of buckets) {
        const bDate = new Date(b.date + 'T00:00:00Z')
        if (isSameUtcDay(day, bDate)) {
          b.count++
          break
        }
      }
    }

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
      // Lifetime total surfaced separately so the UI can display
      // "42 lifetime · 12 in last 7d" once we want it. Today only
      // the windowed total is rendered, but the lifetime number is
      // useful for sanity-checking against the master tracker.
      lifetimeTotal: allMine.length,
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

  // Prior-window totals — same attribution but on the shifted date
  // range. Used only for the header delta tile, so we don't need
  // the full per-agent breakdown.
  let bookingsPriorWindow = 0
  if (priorSince && priorUntil) {
    for (const list of attributedByAgent.values()) {
      for (const entry of list) {
        if (!entry.loggedAt) continue
        if (entry.loggedAt < priorSince) continue
        if (entry.loggedAt >= priorUntil) continue
        // Apply the same client filter so the delta stays apples-
        // to-apples with the visible totals.
        if (clientFilter !== 'all') {
          const route = routeRowToClient(
            {
              client: entry.row.client,
              address: normalizeAddress(entry.row.address),
            },
            routingIndex,
          )
          if (route.source === 'unrouted') continue
          if (route.client.id !== clientFilter) continue
        }
        bookingsPriorWindow++
      }
    }
  }

  const recencyCutoff = new Date(
    Date.now() - ACTIVE_RECENCY_DAYS * 24 * 60 * 60 * 1000,
  )
  const filteredRows = activeOnly
    ? rows.filter(
        (r) =>
          r.lastActivityAt && new Date(r.lastActivityAt) >= recencyCutoff,
      )
    : rows

  // Header summary — aggregates from the filtered (visible) rows so
  // the tiles always match what's drawn below.
  const totalBookingsThisWindow = filteredRows.reduce(
    (s, r) => s + r.bookings.total,
    0,
  )
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
    excludedHidden: agentsRaw.length - agents.length,
    /** Sheet rows that couldn't be attributed to any roster agent —
     *  no matching agentEmail, no DB row, OR DB row pointed at a
     *  hidden test account, AND the sole-agent fallback didn't apply.
     *  Surfaced as a data-quality banner on the page so admin can
     *  chase down missing attribution (usually a blank agentEmail
     *  column on a manual sheet entry). */
    unattributedSheetRows: unattributed.length,
    /** Breakdown by sheet source — secondary-sheet rows almost
     *  always come from partner call centers (Yassin's team) whose
     *  agents aren't Hub users, so a non-zero `secondary` count is
     *  expected and not a data quality problem. Primary-sheet
     *  unattributed rows ARE a problem and should be zero on a
     *  single-agent workspace thanks to the sole-agent fallback. */
    unattributedBreakdown: {
      primary: unattributed.filter((e) => e.row.source.kind === 'primary')
        .length,
      secondary: unattributed.filter((e) => e.row.source.kind === 'secondary')
        .length,
    },
    /** Total sheet rows we considered after dropping empty rows.
     *  Lets the UI show "X attributed · Y unattributed" if useful. */
    totalSheetRowsConsidered,
    summary: {
      activeAgents: activeThisWindow,
      totalAgents: filteredRows.length,
      bookingsThisWindow: totalBookingsThisWindow,
      bookingsPriorWindow,
      bookingsDelta:
        priorSince !== null
          ? totalBookingsThisWindow - bookingsPriorWindow
          : null,
      pipelineDollars: totalPipeline,
      avgShowRate,
      eodConsistency,
    },
    agents: filteredRows,
    clients,
  })
}
