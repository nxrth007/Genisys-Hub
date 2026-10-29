/**
 * Office state builder: reads the real Hub tables and hands plain rows to
 * the pure mapping in ./mapping.ts. Read-only; no new tables.
 */
import { prisma } from '@/lib/prisma'
import { deriveOffice, emptyInput, type OfficeInput, type OfficeState, type RenderMonitorIn } from './mapping'

const DAY = 24 * 60 * 60_000
const FEED_WINDOW = 3 * DAY

export async function buildOfficeState(now = new Date()): Promise<OfficeState> {
  const since = new Date(now.getTime() - FEED_WINDOW)
  const input: OfficeInput = emptyInput()
  // Each source is independent: one failing query leaves that bot idle
  // instead of breaking the whole office.
  const safe = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      console.error(`[office] ${label} failed:`, err instanceof Error ? err.message : err)
      return fallback
    }
  }

  const [events, stages, intakes, claims, matches, runs, a2p, render] = await Promise.all([
    safe('journey events', () =>
      prisma.clientJourneyEvent.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: 150,
        select: { id: true, clientId: true, stage: true, fromStatus: true, toStatus: true, note: true, actor: true, createdAt: true, client: { select: { name: true } } },
      }), []),
    safe('open stages', () =>
      prisma.clientJourneyStage.findMany({
        where: { status: { in: ['blocked', 'in_progress'] }, client: { archivedAt: null } },
        orderBy: { updatedAt: 'desc' },
        take: 100,
        select: { clientId: true, stage: true, status: true, note: true, updatedAt: true, client: { select: { name: true } } },
      }), []),
    safe('intakes', () =>
      prisma.clientIntake.findMany({
        where: { receivedAt: { gte: since } },
        orderBy: { receivedAt: 'desc' },
        take: 30,
        select: { id: true, receivedAt: true, status: true, businessName: true, fullName: true, client: { select: { name: true } } },
      }), []),
    safe('whop claims', () => prisma.whopSignupClaim.findMany({ where: { claimedAt: { gte: since } }, orderBy: { claimedAt: 'desc' }, take: 30 }), []),
    safe('match suggestions', () =>
      prisma.subaccountMatchSuggestion.findMany({
        where: { OR: [{ status: 'needs_review' }, { createdAt: { gte: since } }] },
        orderBy: { updatedAt: 'desc' },
        take: 50,
        select: { id: true, locationName: true, score: true, status: true, createdAt: true, updatedAt: true, client: { select: { name: true } } },
      }), []),
    safe('seo runs', () =>
      prisma.seoRun.findMany({
        where: { OR: [{ status: { in: ['running', 'queued', 'awaiting_review'] } }, { updatedAt: { gte: since } }] },
        orderBy: { updatedAt: 'desc' },
        take: 40,
        select: { id: true, status: true, stage: true, error: true, startedAt: true, finishedAt: true, createdAt: true, updatedAt: true, site: { select: { name: true } } },
      }), []),
    safe('a2p', () =>
      prisma.hlA2p.findMany({
        where: { updatedAt: { gte: since } },
        orderBy: { updatedAt: 'desc' },
        take: 20,
        select: { id: true, stage: true, note: true, updatedAt: true, account: { select: { name: true } } },
      }), []),
    safe('render monitor', () => prisma.appSetting.findUnique({ where: { key: 'render.monitor' } }), null),
  ])

  input.journeyEvents = events.map((e) => ({ ...e, clientName: e.client?.name ?? 'a client' }))
  input.openStages = stages.map((s) => ({ ...s, clientName: s.client?.name ?? 'a client' }))
  input.intakes = intakes.map((i) => ({ id: i.id, receivedAt: i.receivedAt, status: i.status, name: i.client?.name ?? i.businessName ?? i.fullName ?? null }))
  input.whopClaims = claims
  input.matchSuggestions = matches.map((m) => ({ ...m, clientName: m.client?.name ?? 'a client' }))
  input.seoRuns = runs.map((r) => ({ ...r, siteName: r.site?.name ?? 'a site' }))
  input.a2p = a2p.map((a) => ({ id: a.id, stage: a.stage, note: a.note, updatedAt: a.updatedAt, accountName: a.account?.name ?? 'a sub-account' }))
  input.render = parseRenderState(render?.value ?? null, now)

  return deriveOffice(input, now)
}

/** Only counts and timestamps leave the server; no log text. */
export function parseRenderState(raw: string | null, now = new Date()): RenderMonitorIn {
  const enabled = process.env.RENDER_MONITOR_ENABLED === '1'
  if (!raw) return enabled ? { enabled, heartbeatFailures: 0, openProblems: 0, lastDigestAt: null } : null
  try {
    const s = JSON.parse(raw) as { heartbeatFailures?: number; lastDigestAt?: string | null; fingerprints?: Record<string, { lastSeenAt?: string }> }
    return {
      enabled,
      heartbeatFailures: Number(s.heartbeatFailures) || 0,
      // Error patterns seen in the last hour count as open.
      openProblems: Object.values(s.fingerprints ?? {}).filter((f) => f?.lastSeenAt && now.getTime() - new Date(f.lastSeenAt).getTime() < 60 * 60_000).length,
      lastDigestAt: s.lastDigestAt ? new Date(s.lastDigestAt) : null,
    }
  } catch {
    return { enabled, heartbeatFailures: 0, openProblems: 0, lastDigestAt: null }
  }
}
