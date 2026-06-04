import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import {
  TECHNICAL_ISSUE_TAG_VALUES,
  parseReportDate,
} from '@/lib/eod-reports'

/**
 * GET  /api/team/eod-reports  → own EOD reports, most recent first
 * POST /api/team/eod-reports  → create a report for a given shift day
 *
 * Mirror of /api/agent/eod-reports — writes to the same EodReport
 * table. The only differences are the URL prefix (so middleware's
 * /api/team/* allowlist lets team_member through) and the role
 * gate at the top of each handler (team_member only; agents have
 * their own surface).
 *
 * (agentUserId, reportDate) unique index is shared with Mary's
 * flow; a team_member can't submit twice for the same day. POST
 * returns 409 with the existing row's id so the UI can redirect
 * to /team/eod/[id] for editing.
 */

const ALLOWED_ROLES = new Set(['team_member'])

type EodInput = {
  reportDate?: string
  dialsMade?: number
  contactsReached?: number
  appointmentsGenerated?: number
  callbacksScheduled?: number
  technicalIssueTags?: string[]
  technicalIssueNotes?: string | null
  organizationalIssues?: string | null
  wins?: string | null
  tomorrowFocus?: string | null
}

function nonNegativeInt(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
}

function sanitizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out = new Set<string>()
  for (const t of raw) {
    if (typeof t === 'string' && TECHNICAL_ISSUE_TAG_VALUES.has(t)) {
      out.add(t)
    }
  }
  return Array.from(out)
}

function trimOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 ? t : null
}

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role ?? ''
  if (!ALLOWED_ROLES.has(role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const reports = await prisma.eodReport.findMany({
    where: { agentUserId: session.user.id },
    orderBy: { reportDate: 'desc' },
    take: 60,
  })
  return NextResponse.json({ reports })
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role ?? ''
  if (!ALLOWED_ROLES.has(role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: EodInput
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const reportDate = parseReportDate(body.reportDate)
  if (!reportDate) {
    return NextResponse.json(
      { error: 'reportDate (YYYY-MM-DD) is required.' },
      { status: 400 },
    )
  }
  // Same future-date guard as Mary's path; +1 day tolerance for
  // agents in later timezones than the server.
  const tomorrow = new Date()
  tomorrow.setUTCHours(0, 0, 0, 0)
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
  if (reportDate.getTime() > tomorrow.getTime()) {
    return NextResponse.json(
      { error: 'Report date cannot be in the future.' },
      { status: 400 },
    )
  }

  const existing = await prisma.eodReport.findUnique({
    where: {
      agentUserId_reportDate: {
        agentUserId: session.user.id,
        reportDate,
      },
    },
    select: { id: true },
  })
  if (existing) {
    return NextResponse.json(
      {
        error:
          'You already submitted a report for this date. Edit it instead.',
        code: 'ALREADY_EXISTS',
        existingId: existing.id,
      },
      { status: 409 },
    )
  }

  const report = await prisma.eodReport.create({
    data: {
      agentUserId: session.user.id,
      reportDate,
      dialsMade: nonNegativeInt(body.dialsMade),
      contactsReached: nonNegativeInt(body.contactsReached),
      appointmentsGenerated: nonNegativeInt(body.appointmentsGenerated),
      callbacksScheduled: nonNegativeInt(body.callbacksScheduled),
      technicalIssueTags: sanitizeTags(body.technicalIssueTags),
      technicalIssueNotes: trimOrNull(body.technicalIssueNotes),
      organizationalIssues: trimOrNull(body.organizationalIssues),
      wins: trimOrNull(body.wins),
      tomorrowFocus: trimOrNull(body.tomorrowFocus),
    },
  })
  return NextResponse.json({ ok: true, report })
}
