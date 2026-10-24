import { prisma } from '@/lib/prisma'
import type { HlStage } from './types'

/**
 * The numbers behind the sub-account Dashboard (GHL's widgets: opportunity
 * status and value, conversion rate, funnel, lead sources, tasks) plus calls,
 * texts and leads per day, over the last `days` days.
 */
export async function dashboardStats(accountId: string, days = 30) {
  const since = new Date(Date.now() - days * 86_400_000)
  const [contacts, forms, missed, answered, sent, received, failed, pipelines, opps, recent, sources, tasks, appointments] = await Promise.all([
    prisma.hlContact.count({ where: { accountId, createdAt: { gte: since } } }),
    prisma.hlFormSubmission.count({ where: { accountId, createdAt: { gte: since } } }),
    prisma.hlMessage.count({ where: { accountId, channel: 'call', status: 'missed', createdAt: { gte: since } } }),
    prisma.hlMessage.count({ where: { accountId, channel: 'call', status: 'answered', createdAt: { gte: since } } }),
    prisma.hlMessage.count({ where: { accountId, channel: 'sms', direction: 'outbound', status: { in: ['queued', 'sent', 'delivered'] }, createdAt: { gte: since } } }),
    prisma.hlMessage.count({ where: { accountId, channel: 'sms', direction: 'inbound', createdAt: { gte: since } } }),
    prisma.hlMessage.count({ where: { accountId, channel: 'sms', direction: 'outbound', status: { in: ['failed', 'undelivered'] }, createdAt: { gte: since } } }),
    prisma.hlPipeline.findMany({ where: { accountId }, orderBy: { createdAt: 'asc' } }),
    prisma.hlOpportunity.findMany({ where: { accountId }, select: { pipelineId: true, stageId: true, status: true, value: true, source: true, createdAt: true } }),
    prisma.hlContact.findMany({ where: { accountId }, orderBy: { createdAt: 'desc' }, take: 8, select: { id: true, firstName: true, lastName: true, phone: true, email: true, source: true, createdAt: true } }),
    prisma.hlContact.groupBy({ by: ['source'], where: { accountId, createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.hlTask.findMany({
      where: { accountId, completed: false },
      orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }],
      take: 6,
      select: { id: true, title: true, dueDate: true, contact: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } } },
    }),
    prisma.hlAppointment.findMany({
      where: { accountId, startTime: { gte: new Date() }, status: { notIn: ['cancelled', 'invalid'] } },
      orderBy: { startTime: 'asc' },
      take: 6,
      select: { id: true, title: true, startTime: true, contact: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } } },
    }),
  ])
  const byDay = await prisma.hlContact.findMany({ where: { accountId, createdAt: { gte: since } }, select: { createdAt: true } })
  const daily: number[] = Array.from({ length: days }, () => 0)
  for (const c of byDay) {
    const i = days - 1 - Math.floor((Date.now() - c.createdAt.getTime()) / 86_400_000)
    if (i >= 0 && i < days) daily[i]++
  }
  const pipeline = pipelines.find((p) => opps.some((o) => o.pipelineId === p.id && o.status === 'open')) ?? pipelines[0]
  const stages = pipeline
    ? ((pipeline.stages as HlStage[]) ?? []).map((s) => {
        const inStage = opps.filter((o) => o.pipelineId === pipeline.id && o.stageId === s.id && o.status === 'open')
        return { id: s.id, name: s.name, count: inStage.length, value: inStage.reduce((sum, o) => sum + o.value, 0) }
      })
    : []
  const inRange = opps.filter((o) => o.createdAt >= since)
  const status = (s: string) => {
    const list = inRange.filter((o) => o.status === s)
    return { count: list.length, value: list.reduce((sum, o) => sum + o.value, 0) }
  }
  const won = status('won')
  const lost = status('lost')
  const oppSources = new Map<string, { won: number; value: number }>()
  for (const o of inRange) {
    const k = o.source || 'unknown'
    const cur = oppSources.get(k) ?? { won: 0, value: 0 }
    if (o.status === 'won') {
      cur.won++
      cur.value += o.value
    }
    oppSources.set(k, cur)
  }
  return {
    days,
    /** First day of the daily series, for its labels. */
    since: new Date(Date.now() - (days - 1) * 86_400_000).toISOString(),
    contacts,
    forms,
    missed,
    answered,
    sent,
    received,
    failed,
    daily,
    pipeline: pipeline ? { id: pipeline.id, name: pipeline.name, stages } : null,
    opportunities: { open: status('open'), won, lost, abandoned: status('abandoned') },
    conversion: won.count + lost.count ? Math.round((won.count / (won.count + lost.count)) * 100) : null,
    sources: sources
      .map((s) => ({ source: s.source ?? 'unknown', leads: s._count._all, won: oppSources.get(s.source ?? 'unknown')?.won ?? 0, value: oppSources.get(s.source ?? 'unknown')?.value ?? 0 }))
      .sort((a, b) => b.leads - a.leads)
      .slice(0, 8),
    tasks,
    appointments,
    recent,
  }
}
