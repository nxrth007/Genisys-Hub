/**
 * The Sites "Report for the client" checklist, as hashed ledger events.
 * Each item is written once, at the best timestamp the Hub has, with the
 * proof we can actually capture (an HTTP status, a domain row, the number
 * we bought, verification, call forwarding, published workflows).
 * Leads are recorded elsewhere and are not these milestones.
 */
import { prisma } from '@/lib/prisma'
import { readProfile } from '@/lib/hl/accounts'
import { domainStage, siteHost, siteHref } from '@/lib/site-status'
import { reportReadiness } from '@/lib/hl/client-report-plan'
import { writeLedger, type NewRow } from './ledger'

const LOVABLE = /(^|\.)(lovable\.app|lovableproject\.com|onrender\.com)$/i

async function httpProof(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(8_000),
      headers: { 'User-Agent': 'GenisysHub-evidence/1' },
    })
    return `HTTP ${res.status}`
  } catch (err) {
    const message = err instanceof Error ? err.message : 'request failed'
    return `HTTP check failed (${message.slice(0, 120)})`
  }
}

function pretty(n: string): string {
  const d = n.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : n
}

/** Record checklist items that are done and not already in the ledger. */
export async function syncSetupMilestones(clientId: string): Promise<number> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      name: true,
      siteUrl: true,
      siteLiveAt: true,
      updatedAt: true,
      hlSiteRequest: { select: { status: true, publishedAt: true, finishedAt: true, liveUrl: true, domain: true } },
      hlDomainRequest: { select: { status: true, name: true, detail: true, updatedAt: true } },
      hlAccount: {
        select: {
          id: true,
          profile: true,
          updatedAt: true,
          numbers: {
            where: { status: 'active', kind: 'toll_free' },
            orderBy: { createdAt: 'asc' },
            select: { id: true, number: true, provider: true, forwardTo: true, verificationStatus: true, verificationAt: true, verificationNote: true, createdAt: true, updatedAt: true },
          },
          domains: { select: { name: true, origin: true, status: true, createdAt: true, costCents: true } },
          workflows: { select: { template: true, status: true, name: true, publishedAt: true, updatedAt: true } },
        },
      },
    },
  })
  if (!client) return 0
  const have = new Set(
    (await prisma.serviceLedgerEntry.findMany({ where: { clientId, source: 'setup' }, select: { sourceId: true } })).map((r) => r.sourceId),
  )
  const account = client.hlAccount
  const profile = readProfile(account?.profile)
  const own = siteHost(client.siteUrl)
  const tollFree = account?.numbers[0] ?? null
  const form = have.has(`${clientId}:form`)
    ? { done: true, detail: '', at: new Date() }
    : await formEvidence(client.id, client.hlSiteRequest, client.siteUrl)
  const readiness = reportReadiness({
    siteLive: !!client.siteUrl?.trim(),
    domain: domainStage({
      domains: (account?.domains ?? []).map((d) => ({ ...d, createdAt: d.createdAt.toISOString() })),
      question: client.hlDomainRequest,
      siteHost: own && !LOVABLE.test(own) ? own : null,
    }).status === 'done',
    tollFree: tollFree ? { verificationStatus: tollFree.verificationStatus, forwardTo: tollFree.forwardTo } : null,
    siteOnHellLevel: form.done,
    workflows: account?.workflows ?? [],
    reviewLink: !!profile.reviewLink,
    profileMissing: [
      !profile.businessName && 'business name',
      !profile.ownerFirstName && 'owner first name',
      !profile.website && 'website',
      !profile.notifyPhone && 'notification phone',
      !profile.notifyEmail && 'notification email',
    ].filter((x): x is string => !!x),
  })

  const rows: NewRow[] = []
  const add = (key: string, kind: string, title: string, detail: string, at: Date) => {
    const sourceId = `${clientId}:${key}`
    if (have.has(sourceId)) return
    rows.push({ clientId, kind, title, detail, occurredAt: at, source: 'setup', sourceId })
  }

  for (const item of readiness.items) {
    if (!item.done) continue
    if (item.key === 'site' && client.siteUrl && !have.has(`${clientId}:site`)) {
      const url = siteHref(client.siteUrl.trim())
      const proof = await httpProof(url)
      add('site', 'setup_site', 'Website live', `${url} — ${proof}`, client.siteLiveAt ?? client.updatedAt)
    } else if (item.key === 'domain') {
      const active = account?.domains.find((d) => d.status === 'active') ?? account?.domains.find((d) => d.status !== 'failed')
      const note = active
        ? `${active.name} (${active.origin}${active.costCents ? `, $${(active.costCents / 100).toFixed(2)}` : ''})`
        : own
          ? `${own}, the site's own domain`
          : 'domain on file'
      add('domain', 'setup_domain', 'Domain bought', note, active?.createdAt ?? client.hlDomainRequest?.updatedAt ?? client.updatedAt)
    } else if (item.key === 'number' && tollFree) {
      add('number', 'setup_number', 'Toll-free number bought', `${pretty(tollFree.number)} via ${tollFree.provider}`, tollFree.createdAt)
    } else if (item.key === 'texting' && tollFree) {
      add(
        'texting',
        'setup_texting',
        'Texting approved',
        `${pretty(tollFree.number)} verification ${tollFree.verificationStatus}${tollFree.verificationNote ? ` — ${tollFree.verificationNote.slice(0, 180)}` : ''}`,
        tollFree.verificationAt ?? tollFree.updatedAt,
      )
    } else if (item.key === 'calls' && tollFree?.forwardTo) {
      add('calls', 'setup_calls', 'Calls ring the owner', `Calls to ${pretty(tollFree.number)} ring ${pretty(tollFree.forwardTo)}`, tollFree.updatedAt)
    } else if (item.key === 'form') {
      add('form', 'setup_form', 'Site uses Genisys OS form and chat', form.detail, form.at)
    } else if (item.key === 'automations') {
      const flows = (account?.workflows ?? []).filter((w) => ['missed_call', 'quote_form', 'chat_widget'].includes(w.template ?? '') && w.status === 'published')
      const at = latest(flows.map((w) => w.publishedAt ?? w.updatedAt)) ?? account?.updatedAt ?? client.updatedAt
      add('automations', 'setup_automations', 'Lead automations on', flows.map((w) => `${w.template} published ${w.publishedAt ? w.publishedAt.toISOString() : 'without a publish time'}`).join('; '), at)
    } else if (item.key === 'reviews') {
      const review = (account?.workflows ?? []).find((w) => w.template === 'review_request' && w.status === 'published')
      const host = profile.reviewLink ? safeHost(profile.reviewLink) : 'review link on file'
      add('reviews', 'setup_reviews', 'Google review requests on', `Review link ${host}. Workflow ${review?.publishedAt ? `published ${review.publishedAt.toISOString()}` : 'published'}.`, review?.publishedAt ?? review?.updatedAt ?? account?.updatedAt ?? client.updatedAt)
    } else if (item.key === 'profile') {
      add(
        'profile',
        'setup_profile',
        'Business profile complete',
        `On file: business name, owner, website${profile.website ? ` (${profile.website})` : ''}, notification phone, notification email. Values other than the public website are not copied into this line.`,
        account?.updatedAt ?? client.updatedAt,
      )
    }
  }
  return writeLedger(rows)
}

function latest(dates: (Date | null | undefined)[]): Date | null {
  const ms = dates.filter((d): d is Date => !!d).map((d) => d.getTime())
  if (!ms.length) return null
  return new Date(Math.max(...ms))
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return 'on file'
  }
}

async function formEvidence(
  clientId: string,
  site: { status: string; publishedAt: Date | null; finishedAt: Date | null; liveUrl: string | null } | null,
  siteUrl: string | null,
): Promise<{ done: boolean; detail: string; at: Date }> {
  if (site && ['published', 'connected'].includes(site.status)) {
    return {
      done: true,
      detail: `Site build ${site.status}${site.liveUrl ? ` at ${site.liveUrl}` : ''}. Genisys OS form and chat ship with that build.`,
      at: site.publishedAt ?? site.finishedAt ?? new Date(),
    }
  }
  const swap = await swapState(clientId)
  if (swap?.status === 'done') {
    return {
      done: true,
      detail: `Widget swap finished${swap.at ? ` ${swap.at}` : ''}${siteUrl ? ` on ${siteUrl}` : ''}.`,
      at: swap.at ? new Date(swap.at) : new Date(),
    }
  }
  if (siteUrl) {
    const url = siteHref(siteUrl.trim())
    const proof = await pageHasOsWidget(url)
    if (proof.found) return { done: true, detail: `${url} — ${proof.note}`, at: new Date() }
  }
  return { done: false, detail: 'Genisys OS form and chat are not on the live site yet.', at: new Date() }
}

async function pageHasOsWidget(url: string): Promise<{ found: boolean; note: string }> {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8_000), headers: { 'User-Agent': 'GenisysHub-evidence/1' } })
    const text = (await res.text()).slice(0, 200_000)
    const found = text.includes('/hl/widget.js')
    return { found, note: `HTTP ${res.status}${found ? ', page includes /hl/widget.js' : ', page does not include /hl/widget.js'}` }
  } catch (err) {
    return { found: false, note: err instanceof Error ? err.message.slice(0, 120) : 'fetch failed' }
  }
}

async function swapState(clientId: string): Promise<{ status?: string; at?: string; liveOk?: boolean } | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: `hlWidgetSwap:${clientId}` } }).catch(() => null)
  if (!row) return null
  try {
    const v = JSON.parse(row.value) as { status?: string; log?: { at?: string }[] }
    const at = Array.isArray(v.log) ? v.log.map((e) => e.at).filter((x): x is string => !!x).sort().at(-1) : undefined
    return { status: v.status, at }
  } catch {
    return null
  }
}
