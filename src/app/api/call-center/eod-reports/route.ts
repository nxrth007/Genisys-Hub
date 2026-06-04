import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { parseReportDate } from '@/lib/eod-reports'

/**
 * GET /api/call-center/eod-reports
 * Staff view across all agents (middleware blocks role=agent). Filters:
 *   agent   — filter by a specific agent userId
 *   since   — YYYY-MM-DD, only reports on/after this shift date
 *   until   — YYYY-MM-DD, only reports on/before this shift date
 *   hasIssues — "1" to only return reports that flagged tech/org issues
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const sp = req.nextUrl.searchParams
  const where: Record<string, unknown> = {}

  const agent = sp.get('agent')
  if (agent && agent !== 'all') where.agentUserId = agent

  // Team filter — splits Mary's reports from Team #1's. 'agent' =
  // Mary + future regular agents; 'team1' = team_member role only.
  // Omitted means "show everyone" (legacy behavior preserved).
  const team = sp.get('team')
  if (team === 'agent') {
    where.agent = { role: 'agent' }
  } else if (team === 'team1') {
    where.agent = { role: 'team_member', teamNumber: 1 }
  }

  const since = sp.get('since')
  const until = sp.get('until')
  if (since || until) {
    const date: Record<string, Date> = {}
    if (since) {
      const d = parseReportDate(since)
      if (d) date.gte = d
    }
    if (until) {
      const d = parseReportDate(until)
      if (d) date.lte = d
    }
    if (Object.keys(date).length > 0) where.reportDate = date
  }

  const reports = await prisma.eodReport.findMany({
    where,
    orderBy: [{ reportDate: 'desc' }, { createdAt: 'desc' }],
    take: 500,
    include: {
      agent: { select: { id: true, name: true, email: true } },
    },
  })

  // Optional post-filter — "has issues" is any tech tag OR nonempty
  // tech/organizational notes. Doing it in-memory is fine at our scale and
  // avoids a clunkier Prisma OR expression.
  let filtered = reports
  if (sp.get('hasIssues') === '1') {
    filtered = reports.filter(
      (r) =>
        (r.technicalIssueTags && r.technicalIssueTags.length > 0) ||
        !!r.technicalIssueNotes ||
        !!r.organizationalIssues
    )
  }

  return NextResponse.json({ reports: filtered })
}
