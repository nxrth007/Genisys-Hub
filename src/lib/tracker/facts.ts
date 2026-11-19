/**
 * The facts behind the derived client tracker (src/lib/tracker/derive.ts):
 * one query over the clients with everything the rules read, the Google
 * profile boards, the Automation Copy boards, and the Stripe billing view
 * (cached two minutes in stripe-billing.ts). Stripe failing never fails the
 * tracker: the sign-up step then says it couldn't be read.
 */
import { prisma } from '@/lib/prisma'
import { gbpOverview } from '@/lib/gbp-setup'
import { AUTOMATION_IDS } from '@/lib/automation-copy'
import { AUTOMATION_COPY_PREFIX, parseSavedCopy } from '@/lib/automation-copy-saved'
import { currentCensus, readCensusNumbers } from '@/lib/ghl-number/census-plan'
import { staysOnGhl } from '@/lib/hl/widget-swap-plan'
import { SITE_STATUS_TEXT, type SiteStatus as BuildStatus } from '@/lib/hl/site-plan'
import { personName } from '@/lib/site-status'
import { clientSubscriptionsView, type ClientSubscriptionsView } from '@/lib/stripe-billing'
import { stripeLink } from '@/lib/stripe-billing-plan'
import { MANUAL_FIELDS, NO_MARKS, type ClientFacts, type ManualMarks } from './derive'

const BILLING_WAIT_MS = 12_000

export type BillingRead = { asOf: string | null; error: string | null; account: { id: string | null; name: string | null } | null }

/** The Stripe view, or why there is none; never throws, never waits past BILLING_WAIT_MS. */
async function readBilling(refresh: boolean): Promise<{ view: ClientSubscriptionsView | null; read: BillingRead }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), BILLING_WAIT_MS)
  })
  try {
    const view = await Promise.race([clientSubscriptionsView({ refresh }), timeout])
    if (!view) return { view: null, read: { asOf: null, error: 'Stripe took too long to answer', account: null } }
    return { view, read: { asOf: view.asOf, error: view.error, account: { id: view.account.id, name: view.account.name } } }
  } catch (err) {
    return { view: null, read: { asOf: null, error: err instanceof Error ? err.message : 'Stripe couldn’t be read', account: null } }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null)

export type TrackerFacts = {
  facts: ClientFacts[]
  /** The tracker row each client has (hand marks, the sheet's row), by client id. */
  rows: Map<string, { hasRow: boolean; sheetRow: number | null }>
  billing: BillingRead
}

export async function trackerFacts(o: { includeArchived?: boolean; refresh?: boolean; clientId?: string } = {}): Promise<TrackerFacts> {
  const where = o.clientId ? { id: o.clientId } : o.includeArchived ? {} : { archivedAt: null }
  const [clients, gbpRows, copyRows, billing] = await Promise.all([
    prisma.client.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        color: true,
        lifecycle: true,
        archivedAt: true,
        createdAt: true,
        contactName: true,
        contactEmail: true,
        siteUrl: true,
        siteLiveAt: true,
        ghlLocationId: true,
        intakes: { orderBy: { receivedAt: 'desc' }, take: 1, select: { receivedAt: true, businessName: true, fullName: true, leadEmail: true } },
        tracker: true,
        journeyStages: { select: { stage: true, status: true, note: true, updatedAt: true } },
        hlAccount: {
          select: {
            id: true,
            createdAt: true,
            archivedAt: true,
            workflows: { where: { deletedAt: null }, select: { status: true } },
            numbers: { where: { status: 'active' }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }], select: { number: true, kind: true, verificationStatus: true, verificationNote: true, verificationAt: true, createdAt: true } },
            domains: { orderBy: { createdAt: 'asc' }, select: { name: true, origin: true, status: true, createdAt: true } },
            a2p: { select: { stage: true, campaignStatus: true, filedAt: true, approvedAt: true, updatedAt: true } },
          },
        },
        ghlNumberCensus: { select: { locationId: true, state: true, numbers: true, checkedAt: true, version: true } },
        ghlNumberJob: { select: { registration: true } },
        ghlCustomizeJob: { select: { status: true, finishedAt: true, updatedAt: true } },
        hlSiteRequest: { select: { status: true, liveUrl: true, publishedAt: true, updatedAt: true } },
        hlDomainRequest: { select: { status: true, name: true, detail: true } },
        hlNumberRequest: { select: { status: true, route: true, number: true, detail: true, updatedAt: true } },
        seoSite: { select: { mode: true, enabled: true, archivedAt: true, lastRunAt: true, lastScore: true } },
      },
    }),
    gbpOverview().catch((err) => {
      console.warn('[tracker] Google profile boards:', err)
      return []
    }),
    prisma.appSetting.findMany({ where: { key: { startsWith: AUTOMATION_COPY_PREFIX } }, select: { key: true, value: true } }),
    readBilling(o.refresh === true),
  ])
  const gbpById = new Map(gbpRows.map((g) => [g.id, g]))
  const copyById = new Map(copyRows.map((r) => [r.key.slice(AUTOMATION_COPY_PREFIX.length), parseSavedCopy(r.value)]))
  const accountId = billing.view?.account.id ?? null
  const rows = new Map<string, { hasRow: boolean; sheetRow: number | null }>()

  const facts = clients.map((c): ClientFacts => {
    const intake = c.intakes[0] ?? null
    const t = c.tracker
    rows.set(c.id, { hasRow: !!t, sheetRow: t?.sheetRow ?? null })
    const manual: ManualMarks = { ...NO_MARKS }
    if (t) {
      for (const [step, field] of Object.entries(MANUAL_FIELDS) as [keyof typeof MANUAL_FIELDS, (typeof MANUAL_FIELDS)[keyof typeof MANUAL_FIELDS]][]) manual[step] = t[field] === 'done' ? 'done' : 'pending'
      manual.updatedAt = iso(t.updatedAt)
      manual.source = t.source
    }
    const b = billing.view?.byClient[c.id] ?? null
    const census = currentCensus(c.ghlNumberCensus, c.ghlLocationId)
    const copy = copyById.get(c.id)
    const done = copy ? AUTOMATION_IDS.filter((a) => copy.done.includes(a)).length : 0
    const g = gbpById.get(c.id)
    const journey: ClientFacts['journey'] = {}
    for (const s of c.journeyStages) journey[s.stage as keyof ClientFacts['journey']] = { status: s.status, note: s.note, updatedAt: iso(s.updatedAt) }
    return {
      id: c.id,
      name: c.name,
      business: intake?.businessName?.trim() || t?.business || null,
      person: personName(intake?.fullName) ?? personName(c.contactName),
      email: (intake?.leadEmail || c.contactEmail || t?.contactEmail)?.toLowerCase() ?? null,
      color: c.color,
      lifecycle: c.lifecycle,
      archived: !!c.archivedAt,
      createdAt: c.createdAt.toISOString(),
      intake: intake ? { receivedAt: intake.receivedAt.toISOString() } : null,
      billing:
        b && b.state !== 'none'
          ? {
              state: b.state,
              subscription: b.subscription,
              created: b.subscription?.created ?? null,
              href: b.subscription ? stripeLink('subscription', b.subscription.id, { accountId, livemode: b.subscription.livemode }) : b.customers[0] ? stripeLink('customer', b.customers[0].id, { accountId }) : null,
            }
          : null,
      billingKnown: !!billing.view && !billing.view.error,
      journey,
      hl: c.hlAccount
        ? {
            id: c.hlAccount.id,
            createdAt: c.hlAccount.createdAt.toISOString(),
            archived: !!c.hlAccount.archivedAt,
            workflows: { published: c.hlAccount.workflows.filter((w) => w.status === 'published').length, total: c.hlAccount.workflows.length },
            numbers: c.hlAccount.numbers.map((n) => ({ ...n, verificationAt: iso(n.verificationAt), createdAt: n.createdAt.toISOString() })),
            domains: c.hlAccount.domains.map((d) => ({ ...d, createdAt: d.createdAt.toISOString() })),
            a2p: c.hlAccount.a2p ? { stage: c.hlAccount.a2p.stage, campaignStatus: c.hlAccount.a2p.campaignStatus, filedAt: iso(c.hlAccount.a2p.filedAt), approvedAt: iso(c.hlAccount.a2p.approvedAt), updatedAt: c.hlAccount.a2p.updatedAt.toISOString() } : null,
          }
        : null,
      ghl: {
        linked: !!c.ghlLocationId,
        staysOnGhl: staysOnGhl(c.name),
        censusNumbers: readCensusNumbers(census?.numbers).map((n) => ({ number: n.number, tollFree: n.tollFree, verificationRequired: n.verificationRequired })),
        censusAt: iso(census?.checkedAt),
        registration: c.ghlNumberJob?.registration ?? null,
        customize: c.ghlCustomizeJob ? { status: c.ghlCustomizeJob.status, finishedAt: iso(c.ghlCustomizeJob.finishedAt), updatedAt: c.ghlCustomizeJob.updatedAt.toISOString() } : null,
      },
      siteUrl: c.siteUrl,
      siteLiveAt: iso(c.siteLiveAt),
      siteBuild: c.hlSiteRequest
        ? {
            status: c.hlSiteRequest.status,
            label: SITE_STATUS_TEXT[c.hlSiteRequest.status as BuildStatus] ?? c.hlSiteRequest.status.replace(/_/g, ' '),
            liveUrl: c.hlSiteRequest.liveUrl,
            publishedAt: iso(c.hlSiteRequest.publishedAt),
            updatedAt: c.hlSiteRequest.updatedAt.toISOString(),
          }
        : null,
      domainQuestion: c.hlDomainRequest ? { status: c.hlDomainRequest.status, name: c.hlDomainRequest.name, detail: c.hlDomainRequest.detail } : null,
      numberRequest: c.hlNumberRequest ? { ...c.hlNumberRequest, updatedAt: c.hlNumberRequest.updatedAt.toISOString() } : null,
      automationCopy: { done, total: AUTOMATION_IDS.length, updatedAt: copy?.updatedAt ?? null },
      gbp: g ? { status: g.status, profileUrl: g.profileUrl } : null,
      seo: c.seoSite ? { mode: c.seoSite.mode, enabled: c.seoSite.enabled, archived: !!c.seoSite.archivedAt, lastRunAt: iso(c.seoSite.lastRunAt), lastScore: c.seoSite.lastScore } : null,
      manual,
    }
  })
  return { facts, rows, billing: billing.read }
}
