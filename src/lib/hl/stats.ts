import { prisma } from '@/lib/prisma'
import { lastGscHealth } from '@/lib/seo/gsc-health'
import type { HlStage } from './types'

/** A text to a missed caller within this long counts as the text-back (quiet hours can hold it overnight). */
const TEXT_BACK_MS = 12 * 60 * 60_000

/** What the system did between two dates: the results' headline counts (also run for the period before, to compare). */
async function resultCounts(accountId: string, from: Date, to: Date) {
  const range = { gte: from, lt: to }
  const reviewFlows = (await prisma.hlWorkflow.findMany({ where: { accountId, template: 'review_request' }, select: { id: true } })).map((w) => w.id)
  const [leads, forms, booked, reviewRequests] = await Promise.all([
    prisma.hlContact.count({ where: { accountId, createdAt: range } }),
    prisma.hlFormSubmission.count({ where: { accountId, createdAt: range } }),
    prisma.hlAppointment.count({ where: { accountId, createdAt: range, status: { notIn: ['cancelled', 'invalid'] } } }),
    reviewFlows.length ? prisma.hlWorkflowRun.count({ where: { accountId, workflowId: { in: reviewFlows }, createdAt: range } }) : Promise.resolve(0),
  ])
  return { leads, forms, booked, reviewRequests }
}

/** Missed calls since `since` whose caller got a text afterwards (the missed-call text-back, or the owner's own). */
async function textedBack(accountId: string, since: Date): Promise<number> {
  const calls = await prisma.hlMessage.findMany({ where: { accountId, channel: 'call', status: 'missed', createdAt: { gte: since } }, select: { contactId: true, createdAt: true } })
  if (!calls.length) return 0
  const texts = await prisma.hlMessage.findMany({
    where: { accountId, channel: 'sms', direction: 'outbound', status: { in: ['queued', 'sent', 'delivered'] }, contactId: { in: [...new Set(calls.map((c) => c.contactId))] }, createdAt: { gte: since } },
    select: { contactId: true, createdAt: true },
  })
  return calls.filter((c) => texts.some((t) => t.contactId === c.contactId && t.createdAt >= c.createdAt && t.createdAt.getTime() - c.createdAt.getTime() <= TEXT_BACK_MS)).length
}

/**
 * The client's website on Google over the last 28 days, from the last Search
 * Console check (SEO → Search Console health; read, never fetched here, so
 * the dashboard costs Google nothing). Null when their site isn't connected.
 */
async function searchLast28(clientId: string | null): Promise<{ clicks: number; impressions: number; checkedAt: string } | null> {
  if (!clientId) return null
  const [site, health] = await Promise.all([prisma.seoSite.findUnique({ where: { clientId }, select: { id: true } }).catch(() => null), lastGscHealth()])
  const last28 = site && health?.sites.find((s) => s.siteId === site.id)?.last28
  return last28 && health ? { clicks: last28.clicks, impressions: last28.impressions, checkedAt: health.checkedAt } : null
}

/**
 * The sub-account Dashboard: first its results over the last `days` days
 * (leads, calls and the missed-call text-back, texts, appointments booked,
 * review requests, Google search) against the period before, then GHL's
 * widgets (funnel, lead sources, tasks) and calls, texts and leads per day.
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
  const now = new Date()
  const [account, current, previous, backed, byDay] = await Promise.all([
    prisma.hlAccount.findUnique({ where: { id: accountId }, select: { clientId: true, numbers: { where: { status: 'active' }, select: { verificationStatus: true } } } }),
    resultCounts(accountId, since, now),
    resultCounts(accountId, new Date(since.getTime() - days * 86_400_000), since),
    textedBack(accountId, since),
    prisma.hlContact.findMany({ where: { accountId, createdAt: { gte: since } }, select: { createdAt: true } }),
  ])
  const search = await searchLast28(account?.clientId ?? null).catch(() => null)
  const texting: 'live' | 'pending' | 'none' = account?.numbers.some((n) => n.verificationStatus === 'approved') ? 'live' : account?.numbers.length ? 'pending' : 'none'
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
    /** The headline: this period's counts, the period before's, the missed calls texted back, and Google search. */
    results: { ...current, previous, textedBack: backed, texting, search },
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
