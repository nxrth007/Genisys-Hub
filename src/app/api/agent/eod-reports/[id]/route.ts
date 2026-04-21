import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { TECHNICAL_ISSUE_TAG_VALUES } from '@/lib/eod-reports'

/**
 * GET    /api/agent/eod-reports/[id]  → own report
 * PATCH  /api/agent/eod-reports/[id]  → edit any field on own report
 * DELETE /api/agent/eod-reports/[id]  → remove (agent can clear a mistake)
 *
 * Ownership enforced via (id, agentUserId) in the where clause — a non-owner
 * gets 404, same pattern as /api/agent/appointments/[id].
 */

function nonNegativeInt(v: unknown): number | undefined {
  if (v === undefined) return undefined
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.floor(n)
}

function sanitizeTags(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) return undefined
  const out = new Set<string>()
  for (const t of raw) {
    if (typeof t === 'string' && TECHNICAL_ISSUE_TAG_VALUES.has(t)) {
      out.add(t)
    }
  }
  return Array.from(out)
}

function strOrNull(v: unknown): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t.length > 0 ? t : null
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const { id } = await ctx.params
  const report = await prisma.eodReport.findFirst({
    where: { id, agentUserId: session.user.id },
  })
  if (!report) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ report })
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const { id } = await ctx.params

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const owned = await prisma.eodReport.findFirst({
    where: { id, agentUserId: session.user.id },
    select: { id: true },
  })
  if (!owned) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const data: Record<string, unknown> = {}

  const dm = nonNegativeInt(body.dialsMade)
  if (dm !== undefined) data.dialsMade = dm
  const cr = nonNegativeInt(body.contactsReached)
  if (cr !== undefined) data.contactsReached = cr
  const ag = nonNegativeInt(body.appointmentsGenerated)
  if (ag !== undefined) data.appointmentsGenerated = ag
  const cb = nonNegativeInt(body.callbacksScheduled)
  if (cb !== undefined) data.callbacksScheduled = cb

  const tags = sanitizeTags(body.technicalIssueTags)
  if (tags !== undefined) data.technicalIssueTags = tags

  const tin = strOrNull(body.technicalIssueNotes)
  if (tin !== undefined) data.technicalIssueNotes = tin
  const oi = strOrNull(body.organizationalIssues)
  if (oi !== undefined) data.organizationalIssues = oi
  const wins = strOrNull(body.wins)
  if (wins !== undefined) data.wins = wins
  const tf = strOrNull(body.tomorrowFocus)
  if (tf !== undefined) data.tomorrowFocus = tf

  const updated = await prisma.eodReport.update({ where: { id }, data })
  return NextResponse.json({ ok: true, report: updated })
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const { id } = await ctx.params
  const owned = await prisma.eodReport.findFirst({
    where: { id, agentUserId: session.user.id },
    select: { id: true },
  })
  if (!owned) return NextResponse.json({ error: 'not found' }, { status: 404 })
  await prisma.eodReport.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
