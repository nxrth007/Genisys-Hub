import { prisma } from '@/lib/prisma'
import type { HlStage } from './types'

/** Numbers for the sub-account dashboard, over the last `days` days. */
export async function dashboardStats(accountId: string, days = 30) {
  const since = new Date(Date.now() - days * 86_400_000)
  const [contacts, forms, missed, answered, sent, received, failed, pipelines, opps, recent] = await Promise.all([
    prisma.hlContact.count({ where: { accountId, createdAt: { gte: since } } }),
    prisma.hlFormSubmission.count({ where: { accountId, createdAt: { gte: since } } }),
    prisma.hlMessage.count({ where: { accountId, channel: 'call', status: 'missed', createdAt: { gte: since } } }),
    prisma.hlMessage.count({ where: { accountId, channel: 'call', status: 'answered', createdAt: { gte: since } } }),
    prisma.hlMessage.count({ where: { accountId, channel: 'sms', direction: 'outbound', status: { in: ['queued', 'sent', 'delivered'] }, createdAt: { gte: since } } }),
    prisma.hlMessage.count({ where: { accountId, channel: 'sms', direction: 'inbound', createdAt: { gte: since } } }),
    prisma.hlMessage.count({ where: { accountId, channel: 'sms', direction: 'outbound', status: { in: ['failed', 'undelivered'] }, createdAt: { gte: since } } }),
    prisma.hlPipeline.findMany({ where: { accountId }, orderBy: { createdAt: 'asc' } }),
    prisma.hlOpportunity.findMany({ where: { accountId }, select: { pipelineId: true, stageId: true, status: true, value: true } }),
    prisma.hlContact.findMany({ where: { accountId }, orderBy: { createdAt: 'desc' }, take: 8, select: { id: true, firstName: true, lastName: true, phone: true, email: true, source: true, createdAt: true } }),
  ])
  const byDay = await prisma.hlContact.findMany({ where: { accountId, createdAt: { gte: since } }, select: { createdAt: true } })
  const daily: number[] = Array.from({ length: days }, () => 0)
  for (const c of byDay) {
    const i = days - 1 - Math.floor((Date.now() - c.createdAt.getTime()) / 86_400_000)
    if (i >= 0 && i < days) daily[i]++
  }
  const pipeline = pipelines[0]
  const stages = pipeline
    ? ((pipeline.stages as HlStage[]) ?? []).map((s) => {
        const inStage = opps.filter((o) => o.pipelineId === pipeline.id && o.stageId === s.id && o.status === 'open')
        return { id: s.id, name: s.name, count: inStage.length, value: inStage.reduce((sum, o) => sum + o.value, 0) }
      })
    : []
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
    won: opps.filter((o) => o.status === 'won').reduce((s, o) => s + o.value, 0),
    open: opps.filter((o) => o.status === 'open').length,
    recent,
  }
}
