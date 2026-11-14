/**
 * Office state builder: reads the real Hub tables and hands plain rows to
 * the pure mapping in ./mapping.ts. Read-only; no new tables.
 */
import { prisma } from '@/lib/prisma'
import { ghlPhoneSystemLink } from '@/lib/ghl-number/queue'
import { readChoices } from '@/lib/hl/domain-plan'
import { bareHost, siteDomainChoice } from '@/lib/hl/site-plan'
import { deriveOffice, emptyInput, SUBACCOUNT_OPEN_MS, type OfficeInput, type OfficeState, type RenderMonitorIn } from './mapping'

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

  const openSince = new Date(now.getTime() - SUBACCOUNT_OPEN_MS)
  const [events, stages, intakes, claims, matches, runs, a2p, render, subaccountJobs, customizeJobs, numberRequests] = await Promise.all([
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
    safe('sub-account jobs', () =>
      prisma.ghlSubaccountJob.findMany({
        where: {
          client: { is: { archivedAt: null } },
          OR: [
            { status: { in: ['queued', 'running'] } },
            { status: { in: ['needs_human', 'failed'] }, updatedAt: { gte: openSince } },
            { updatedAt: { gte: since } },
          ],
        },
        orderBy: { updatedAt: 'desc' },
        take: 40,
        select: { id: true, clientId: true, status: true, detail: true, updatedAt: true, heartbeatAt: true, nextAttemptAt: true, finishedAt: true, client: { select: { name: true } } },
      }), []),
    safe('customize jobs', () =>
      prisma.ghlCustomizeJob.findMany({
        where: {
          client: { is: { archivedAt: null } },
          OR: [
            { status: { in: ['queued', 'running'] } },
            { status: { in: ['needs_human', 'failed', 'held'] }, updatedAt: { gte: openSince } },
            { updatedAt: { gte: since } },
          ],
        },
        orderBy: { updatedAt: 'desc' },
        take: 40,
        select: { id: true, clientId: true, status: true, detail: true, updatedAt: true, heartbeatAt: true, nextAttemptAt: true, finishedAt: true, client: { select: { name: true } } },
      }), []),
    safe('number requests', () =>
      prisma.hlNumberRequest.findMany({
        where: {
          client: { is: { archivedAt: null } },
          OR: [
            { status: { in: ['awaiting_approval', 'awaiting_identity', 'buying', 'ghl_working'] } },
            { status: 'failed', updatedAt: { gte: openSince } },
            { status: 'bought', verifyNote: { not: null } },
            { updatedAt: { gte: since } },
          ],
        },
        orderBy: { updatedAt: 'desc' },
        take: 40,
        select: { id: true, clientId: true, status: true, route: true, number: true, numberId: true, forwardTo: true, detail: true, verifyNote: true, decidedAt: true, updatedAt: true, client: { select: { name: true, ghlLocationId: true } } },
      }), []),
  ])

  input.journeyEvents = events.map((e) => ({ ...e, clientName: e.client?.name ?? 'a client' }))
  input.openStages = stages.map((s) => ({ ...s, clientName: s.client?.name ?? 'a client' }))
  input.intakes = intakes.map((i) => ({ id: i.id, receivedAt: i.receivedAt, status: i.status, name: i.client?.name ?? i.businessName ?? i.fullName ?? null }))
  input.whopClaims = claims
  input.matchSuggestions = matches.map((m) => ({ ...m, clientName: m.client?.name ?? 'a client' }))
  input.seoRuns = runs.map((r) => ({ ...r, siteName: r.site?.name ?? 'a site' }))
  input.a2p = a2p.map((a) => ({ id: a.id, stage: a.stage, note: a.note, updatedAt: a.updatedAt, accountName: a.account?.name ?? 'a sub-account' }))
  input.render = parseRenderState(render?.value ?? null, now)
  input.subaccountJobs = [
    ...subaccountJobs.map((j) => ({ ...j, clientName: j.client?.name ?? 'a client' })),
    ...customizeJobs.map((j) => ({ ...j, clientName: j.client?.name ?? 'a client', kind: 'customize' as const })),
  ]
  const asking = new Set(['awaiting_approval', 'awaiting_identity'])
  input.approvals = numberRequests
    .filter((r) => asking.has(r.status))
    .map((r) => ({
      id: r.id,
      kind: 'number' as const,
      clientName: r.client?.name ?? 'a client',
      ringTo: r.forwardTo,
      at: r.updatedAt,
      stage: r.status === 'awaiting_identity' ? ('identity' as const) : ('ask' as const),
      ghlLink: r.client?.ghlLocationId ? ghlPhoneSystemLink(r.client.ghlLocationId) : null,
      detail: r.status === 'awaiting_identity' ? r.detail : null,
    }))
  // Forge's domain questions (src/lib/hl/domain-request.ts): three to pick from, then buying, bought, failed, declined.
  const domainRequests = await safe('domain requests', () =>
    prisma.hlDomainRequest.findMany({
      where: {
        client: { is: { archivedAt: null } },
        OR: [{ status: { in: ['awaiting_approval', 'buying'] } }, { status: 'failed', updatedAt: { gte: openSince } }, { updatedAt: { gte: since } }],
      },
      orderBy: { updatedAt: 'desc' },
      take: 40,
      select: { id: true, status: true, accountId: true, suggestions: true, name: true, detail: true, decidedAt: true, updatedAt: true, client: { select: { name: true } } },
    }), [])
  for (const d of domainRequests) {
    if (d.status !== 'awaiting_approval') continue
    input.approvals.push({
      id: d.id,
      kind: 'domain',
      clientName: d.client?.name ?? 'a client',
      at: d.updatedAt,
      stage: 'ask',
      detail: d.detail,
      choices: readChoices(d.suggestions),
      domainsLink: `/hell-level/${d.accountId}/settings?tab=domains`,
    })
  }
  input.domainRequests = domainRequests
    .filter((d) => d.status !== 'awaiting_approval')
    .map((d) => ({ id: d.id, accountId: d.accountId, clientName: d.client?.name ?? 'a client', status: d.status, name: d.name, detail: d.detail, decidedAt: d.decidedAt, updatedAt: d.updatedAt }))
  // Forge's website builds (src/lib/hl/site-request.ts): asked, under way in Lovable, built (until the link is saved), failed.
  const siteRequests = await safe('site requests', () =>
    prisma.hlSiteRequest.findMany({
      where: {
        client: { is: { archivedAt: null } },
        OR: [
          // Questions (build it? publish it? connect their domain?) stay until someone answers them.
          { status: { in: ['awaiting_approval', 'filling', 'copying', 'sending', 'building', 'waiting_on_lovable', 'built', 'publishing', 'published', 'connecting'] } },
          { status: { in: ['held', 'connected', 'failed'] }, updatedAt: { gte: openSince } },
          { updatedAt: { gte: since } },
        ],
      },
      orderBy: { updatedAt: 'desc' },
      take: 40,
      select: {
        id: true,
        clientId: true,
        status: true,
        detail: true,
        editorUrl: true,
        liveUrl: true,
        fill: true,
        stepAt: true,
        finishedAt: true,
        publishedAt: true,
        domain: true,
        domainStep: true,
        domainStepAt: true,
        domainAt: true,
        updatedAt: true,
        client: {
          select: {
            name: true,
            siteUrl: true,
            seoSite: { select: { repoFullName: true } },
            hlAccount: { select: { id: true, domains: { orderBy: { createdAt: 'asc' }, select: { name: true, origin: true, status: true } } } },
          },
        },
      },
    }), [])
  for (const s of siteRequests) {
    const clientName = s.client?.name ?? 'a client'
    const ready = siteDomainChoice(s.client?.hlAccount?.domains ?? [])
    const siteDomain = ready && 'name' in ready ? ready : null
    const accountId = s.client?.hlAccount?.id ?? null
    if (s.status === 'awaiting_approval') {
      input.approvals.push({ id: s.id, kind: 'site', clientName, at: s.updatedAt, stage: 'ask', detail: s.detail, reviewLink: `/sites/${s.clientId}` })
    } else if (s.status === 'built' && !s.client?.siteUrl?.trim()) {
      // Built and not live: Forge asks to publish it. Under it, what went wrong last time, else what Claude said to check.
      const notes = Array.isArray((s.fill as { notes?: unknown } | null)?.notes) ? ((s.fill as { notes: unknown[] }).notes.filter((n) => typeof n === 'string') as string[]) : []
      const checks = notes.length ? `Claude’s notes to check: ${notes.join(' ')}` : null
      const detail = s.detail?.startsWith('Publishing didn’t finish') ? s.detail : checks && checks.length > 320 ? `${checks.slice(0, 319).trimEnd()}…` : checks
      input.approvals.push({ id: s.id, kind: 'site', clientName, at: s.finishedAt ?? s.updatedAt, stage: 'publish', detail, reviewLink: s.editorUrl ?? `/sites/${s.clientId}`, siteDomain })
    } else if (s.status === 'published' && !s.domainStep && siteDomain && bareHost(s.client?.siteUrl) !== siteDomain.name) {
      // Live on lovable.app and their domain is ready: Forge asks to connect it. Under it, what went wrong last time.
      const detail = s.detail?.startsWith('Connecting') ? s.detail : null
      input.approvals.push({
        id: s.id,
        kind: 'site',
        clientName,
        at: s.publishedAt ?? s.updatedAt,
        stage: 'domain',
        detail,
        reviewLink: accountId ? `/hell-level/${accountId}/settings?tab=domains` : `/sites/${s.clientId}`,
        siteDomain,
      })
    }
  }
  input.siteRequests = siteRequests
    .filter((s) => s.status !== 'awaiting_approval')
    .map((s) => ({
      id: s.id,
      clientId: s.clientId,
      clientName: s.client?.name ?? 'a client',
      status: s.status,
      detail: s.detail,
      editorUrl: s.editorUrl,
      liveUrl: s.liveUrl,
      publishedAt: s.publishedAt,
      accountId: s.client?.hlAccount?.id ?? null,
      domain: s.domain,
      domainStep: s.domainStep,
      domainStepAt: s.domainStepAt,
      domainAt: s.domainAt,
      readyDomain: siteDomainChoice(s.client?.hlAccount?.domains ?? []),
      repoLinked: !!s.client?.seoSite?.repoFullName,
      siteLive: !!s.client?.siteUrl?.trim(),
      stepAt: s.stepAt,
      finishedAt: s.finishedAt,
      updatedAt: s.updatedAt,
    }))
  // Site forms made the client's own (src/lib/ghl-form): Atlas shows them like the workflow copy job.
  const formJobs = await safe('form jobs', () =>
    prisma.ghlFormJob.findMany({
      where: {
        client: { is: { archivedAt: null } },
        OR: [{ status: { in: ['queued', 'running'] } }, { status: { in: ['needs_human', 'failed'] }, updatedAt: { gte: openSince } }, { updatedAt: { gte: since } }],
      },
      orderBy: { updatedAt: 'desc' },
      take: 40,
      select: { id: true, clientId: true, status: true, detail: true, updatedAt: true, heartbeatAt: true, nextAttemptAt: true, finishedAt: true, client: { select: { name: true } } },
    }), [])
  input.subaccountJobs.push(...formJobs.map((j) => ({ ...j, clientName: j.client?.name ?? 'a client', kind: 'form' as const })))
  // GHL toll-free registrations (src/lib/ghl-number/queue.ts): filled and waiting for an OK, stopped, moving, sent.
  const regs = await safe('ghl registrations', () =>
    prisma.ghlNumberJob.findMany({
      where: {
        client: { is: { archivedAt: null } },
        OR: [{ registration: { in: ['review', 'needs_human', 'queued', 'approved'] } }, { registration: 'submitted', regAt: { gte: since } }],
      },
      orderBy: { updatedAt: 'desc' },
      take: 40,
      select: { id: true, clientId: true, status: true, phase: true, registration: true, regDetail: true, regAt: true, phoneNumber: true, locationId: true, updatedAt: true, client: { select: { name: true } } },
    }), [])
  for (const g of regs) {
    if (g.registration !== 'review' && g.registration !== 'needs_human') continue
    input.approvals.push({
      id: g.id,
      kind: 'registration',
      clientName: g.client?.name ?? 'a client',
      at: g.regAt ?? g.updatedAt,
      stage: g.registration === 'review' ? 'review' : 'blocked',
      ghlLink: ghlPhoneSystemLink(g.locationId),
      // A plain "filled it" says nothing the question doesn't; a changed-details or dry-run note does.
      detail: g.registration === 'needs_human' || (g.regDetail && !/^Filled GHL/.test(g.regDetail)) ? g.regDetail : null,
      number: g.phoneNumber,
      reviewLink: `/sites/${g.clientId}#ghl-registration`,
    })
  }
  input.ghlRegistrations = regs.map((g) => ({
    id: g.id,
    clientName: g.client?.name ?? 'a client',
    registration: g.registration,
    running: g.status === 'running' && g.phase === 'register',
    at: g.regAt ?? g.updatedAt,
  }))
  // Where each bought number's texting verification stands (filed, approved, rejected).
  const numberIds = numberRequests.map((r) => r.numberId).filter((x): x is string => !!x)
  const verifications = numberIds.length
    ? await safe('number verifications', () =>
        prisma.hlPhoneNumber.findMany({ where: { id: { in: numberIds } }, select: { id: true, verificationStatus: true, verificationAt: true, updatedAt: true } }), [])
    : []
  input.numberRequests = numberRequests
    .filter((r) => !asking.has(r.status))
    .map((r) => {
      const v = verifications.find((x) => x.id === r.numberId)
      return {
        id: r.id,
        clientId: r.clientId,
        clientName: r.client?.name ?? 'a client',
        status: r.status,
        route: r.route,
        number: r.number,
        detail: r.detail,
        verifyNote: r.verifyNote,
        decidedAt: r.decidedAt,
        updatedAt: r.updatedAt,
        verification: v?.verificationStatus ?? null,
        verificationAt: v?.verificationAt ?? null,
        verificationChangedAt: v?.updatedAt ?? null,
      }
    })

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
