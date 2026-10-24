import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { hlAccountOr404, hlGuard } from '@/lib/hl/http'

type Ctx = { params: Promise<{ id: string }> }

/**
 * GET ?kind=calls|appointments|reviews&days=90: the numbers behind Reporting
 * (Call Reporting, Appointment Report) and Reputation (review requests sent).
 */
export async function GET(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  const sp = new URL(req.url).searchParams
  const days = Math.min(730, Math.max(7, Number(sp.get('days')) || 90))
  const since = new Date(Date.now() - days * 86_400_000)
  const contact = { select: { id: true, firstName: true, lastName: true, phone: true, email: true } } as const

  if (sp.get('kind') === 'calls') {
    const calls = await prisma.hlMessage.findMany({
      where: { accountId: id, channel: 'call', createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 1000,
      select: { id: true, direction: true, status: true, body: true, meta: true, createdAt: true, contact },
    })
    const count = (s: string) => calls.filter((c) => c.status === s).length
    return NextResponse.json({ days, total: calls.length, answered: count('answered'), missed: count('missed'), inbound: calls.filter((c) => c.direction === 'inbound').length, calls: calls.slice(0, 200) })
  }

  if (sp.get('kind') === 'appointments') {
    const list = await prisma.hlAppointment.findMany({ where: { accountId: id, startTime: { gte: since } }, select: { status: true, calendar: { select: { name: true } } } })
    const byStatus: Record<string, number> = {}
    const byCalendar: Record<string, number> = {}
    for (const a of list) {
      byStatus[a.status] = (byStatus[a.status] ?? 0) + 1
      const c = a.calendar?.name ?? 'No calendar'
      byCalendar[c] = (byCalendar[c] ?? 0) + 1
    }
    return NextResponse.json({ days, total: list.length, byStatus, byCalendar })
  }

  // Review requests: runs of the review workflow(s).
  const workflows = await prisma.hlWorkflow.findMany({
    where: { accountId: id, deletedAt: null, OR: [{ template: 'review_request' }, { name: { contains: 'review', mode: 'insensitive' } }] },
    select: { id: true, name: true, status: true },
  })
  const runs = await prisma.hlWorkflowRun.findMany({
    where: { workflowId: { in: workflows.map((w) => w.id) }, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: 500,
    select: { id: true, status: true, createdAt: true, nextRunAt: true, workflowId: true, contact },
  })
  return NextResponse.json({ days, workflows, runs })
}
