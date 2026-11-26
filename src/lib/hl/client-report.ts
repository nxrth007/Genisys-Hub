/**
 * The client report from a client's folder in Sites (Alex, 2026-11-15): once they're fully set up
 * (./client-report-plan.ts says what that takes), an admin emails the client what their system did
 * in the last 30 days, with the link to their own dashboard login when asked. Nothing goes out
 * without that press. Each send is kept in AppSetting hl.clientReport:<clientId>.
 */
import { getWriterAccountEmail } from '@/lib/drive'
import { sendEmail } from '@/lib/gmail'
import { prisma } from '@/lib/prisma'
import { domainStage, siteHost, siteHref } from '@/lib/site-status'
import { readProfile } from './accounts'
import { REVIEW_REQUEST_FORM } from './client-kit'
import { reportEmail, reportReadiness, type ReadyItem, type ReportNumbers } from './client-report-plan'
import { HlInputError } from './http'
import { inviteLogin, ownerStaffId } from './logins'
import { publicBase } from './twilio'
import { liveCode } from './widget-swap'
import { liveState, liveSwapped } from './widget-swap-plan'

const DAYS = 30
const LOG_KEY = 'hl.clientReport:'
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** A live look at their site, kept this long (the folder asks each time it opens). */
const LIVE_KEEP_MS = 10 * 60_000
const liveSeen = new Map<string, { at: number; ok: boolean }>()

const pretty = (n: string) => {
  const d = n.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : n
}

async function gather(clientId: string) {
  return prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      name: true,
      contactName: true,
      contactEmail: true,
      siteUrl: true,
      archivedAt: true,
      hlSiteRequest: { select: { status: true } },
      hlDomainRequest: { select: { status: true, name: true, detail: true } },
      intakes: { orderBy: { receivedAt: 'desc' }, take: 1, select: { leadEmail: true } },
      hlAccount: {
        select: {
          id: true,
          name: true,
          profile: true,
          archivedAt: true,
          numbers: { where: { status: 'active', kind: 'toll_free' }, orderBy: { createdAt: 'asc' }, select: { number: true, verificationStatus: true, forwardTo: true } },
          domains: { select: { name: true, origin: true, status: true, createdAt: true } },
          workflows: { select: { template: true, status: true } },
          forms: { where: { archivedAt: null, kind: { in: ['form', 'chat'] } }, orderBy: { createdAt: 'asc' }, select: { id: true, kind: true, name: true, ghlId: true } },
          members: { select: { user: { select: { email: true } } } },
        },
      },
    },
  })
}

type Client = NonNullable<Awaited<ReturnType<typeof gather>>>

/** Their site embeds their Genisys OS form and chat: Forge built it, the swap finished, or the live site shows it. */
async function siteOnHellLevel(c: Client): Promise<boolean> {
  if (c.hlSiteRequest && ['published', 'connected'].includes(c.hlSiteRequest.status)) return true
  const swap = await prisma.appSetting.findUnique({ where: { key: `hlWidgetSwap:${c.id}` } }).catch(() => null)
  try {
    if (swap && (JSON.parse(swap.value) as { status?: string }).status === 'done') return true
  } catch {
    /* an unreadable row is no swap */
  }
  const native = c.hlAccount?.forms.filter((f) => !f.ghlId) ?? []
  const quote = native.find((f) => f.kind === 'form' && f.name === 'Website Quote Form') ?? native.find((f) => f.kind === 'form' && f.name !== REVIEW_REQUEST_FORM)
  const chat = native.find((f) => f.kind === 'chat')
  const site = c.siteUrl?.trim()
  if (!quote || !chat || !site) return false
  const seen = liveSeen.get(c.id)
  if (seen && Date.now() - seen.at < LIVE_KEEP_MS) return seen.ok
  const live = await liveCode(siteHref(site)).catch(() => null)
  const state = live ? liveState(live.code, { formId: quote.id, chatId: chat.id }) : null
  const ok = !!state && liveSwapped(state) && state.hlForm
  liveSeen.set(c.id, { at: Date.now(), ok })
  return ok
}

async function readiness(c: Client): Promise<{ ready: boolean; items: ReadyItem[] }> {
  const a = c.hlAccount && !c.hlAccount.archivedAt ? c.hlAccount : null
  const p = readProfile(a?.profile)
  const own = siteHost(c.siteUrl)
  const tollFree = a?.numbers[0] ?? null
  return reportReadiness({
    siteLive: !!c.siteUrl?.trim(),
    domain:
      domainStage({
        domains: (a?.domains ?? []).map((d) => ({ ...d, createdAt: d.createdAt.toISOString() })),
        question: c.hlDomainRequest,
        siteHost: own && !/(^|\.)(lovable\.app|lovableproject\.com|onrender\.com)$/i.test(own) ? own : null,
      }).status === 'done',
    tollFree: tollFree ? { verificationStatus: tollFree.verificationStatus, forwardTo: tollFree.forwardTo } : null,
    siteOnHellLevel: a ? await siteOnHellLevel(c) : false,
    workflows: a?.workflows ?? [],
    reviewLink: !!p.reviewLink,
    profileMissing: [
      !p.businessName && 'business name',
      !p.ownerFirstName && 'owner first name',
      !p.website && 'website',
      !p.notifyPhone && 'notification phone',
      !p.notifyEmail && 'notification email',
    ].filter((x): x is string => !!x),
  })
}

/** What their system did over the last DAYS days (the sub-account Dashboard's counts). */
async function numbersFor(accountId: string): Promise<ReportNumbers> {
  const since = new Date(Date.now() - DAYS * 86_400_000)
  const reviewFlows = (await prisma.hlWorkflow.findMany({ where: { accountId, template: 'review_request' }, select: { id: true } })).map((w) => w.id)
  const [leads, forms, answered, missed, sent, received, appointments, reviewRequests] = await Promise.all([
    prisma.hlContact.count({ where: { accountId, createdAt: { gte: since } } }),
    prisma.hlFormSubmission.count({ where: { accountId, createdAt: { gte: since } } }),
    prisma.hlMessage.count({ where: { accountId, channel: 'call', status: 'answered', createdAt: { gte: since } } }),
    prisma.hlMessage.count({ where: { accountId, channel: 'call', status: 'missed', createdAt: { gte: since } } }),
    prisma.hlMessage.count({ where: { accountId, channel: 'sms', direction: 'outbound', status: { in: ['queued', 'sent', 'delivered'] }, createdAt: { gte: since } } }),
    prisma.hlMessage.count({ where: { accountId, channel: 'sms', direction: 'inbound', createdAt: { gte: since } } }),
    prisma.hlAppointment.count({ where: { accountId, createdAt: { gte: since }, status: { notIn: ['cancelled', 'invalid'] } } }),
    reviewFlows.length ? prisma.hlWorkflowRun.count({ where: { accountId, workflowId: { in: reviewFlows }, createdAt: { gte: since } } }) : Promise.resolve(0),
  ])
  return { days: DAYS, leads, forms, callsAnswered: answered, callsMissed: missed, textsSent: sent, textsReceived: received, appointments, reviewRequests }
}

type Sent = { at: string; to: string; by: string; login: boolean }

async function sentLog(clientId: string): Promise<Sent[]> {
  const row = await prisma.appSetting.findUnique({ where: { key: LOG_KEY + clientId } }).catch(() => null)
  try {
    const v = row ? (JSON.parse(row.value) as unknown) : []
    return Array.isArray(v) ? (v as Sent[]) : []
  } catch {
    return []
  }
}

/** Who the report goes to by default: where owner alerts go, else Clients' contact email, else the onboarding form's. */
function defaultTo(c: Client): string | null {
  const p = readProfile(c.hlAccount?.profile)
  return [p.notifyEmail, c.contactEmail, c.intakes[0]?.leadEmail].map((e) => (e ?? '').trim().toLowerCase()).find((e) => EMAIL.test(e)) ?? null
}

export type ClientReportView = {
  ready: boolean
  items: ReadyItem[]
  to: string | null
  /** Emails that already have a login to their dashboard. */
  logins: string[]
  /** What the email would say now (null until they're ready). */
  draft: { business: string; firstName: string | null; numbers: ReportNumbers; site: { url: string; host: string }; phone: string; signInUrl: string } | null
  last: Sent | null
}

export async function clientReportView(clientId: string): Promise<ClientReportView | null> {
  const c = await gather(clientId)
  if (!c || c.archivedAt) return null
  const r = await readiness(c)
  const a = c.hlAccount
  const p = readProfile(a?.profile)
  const log = await sentLog(clientId)
  const draft =
    r.ready && a && c.siteUrl && a.numbers[0]
      ? {
          business: p.businessName || c.name,
          firstName: p.ownerFirstName || c.contactName?.trim().split(/\s+/)[0] || null,
          numbers: await numbersFor(a.id),
          site: { url: siteHref(c.siteUrl.trim()), host: siteHost(c.siteUrl) },
          phone: pretty(a.numbers[0].number),
          signInUrl: `${publicBase()}/login`,
        }
      : null
  return { ready: r.ready, items: r.items, to: defaultTo(c), logins: a?.members.map((m) => m.user.email) ?? [], draft, last: log[log.length - 1] ?? null }
}

export type SendResult = { ok: true; to: string; login: boolean } | { ok: false; reason: string }

/** Email the client their report (an admin's press in their folder): checked again, then sent once. */
export async function sendClientReport(clientId: string, o: { to: string; includeLogin: boolean; by: string }): Promise<SendResult> {
  const c = await gather(clientId)
  if (!c || c.archivedAt) return { ok: false, reason: 'This client is archived or gone.' }
  const to = o.to.trim().toLowerCase()
  if (!EMAIL.test(to)) return { ok: false, reason: 'That isn’t an email address.' }
  const r = await readiness(c)
  if (!r.ready) return { ok: false, reason: `Not fully set up yet: ${r.items.filter((i) => !i.done).map((i) => i.label.toLowerCase()).join(', ')}.` }
  const a = c.hlAccount!
  const p = readProfile(a.profile)
  const business = p.businessName || c.name
  let login: { link: string; email: string } | null = null
  if (o.includeLogin) {
    try {
      const staffId = await ownerStaffId(a.id, to, p.ownerName || c.contactName?.trim() || business, 'client report')
      login = { link: (await inviteLogin({ accountId: a.id, staffId, email: to, by: o.by, quiet: true })).link, email: to }
    } catch (err) {
      if (err instanceof HlInputError) return { ok: false, reason: err.message }
      throw err
    }
  }
  const numbers = await numbersFor(a.id)
  const email = reportEmail({
    business,
    firstName: p.ownerFirstName || c.contactName?.trim().split(/\s+/)[0] || null,
    numbers,
    site: { url: siteHref(c.siteUrl!.trim()), host: siteHost(c.siteUrl) },
    phone: pretty(a.numbers[0].number),
    login,
    signInUrl: `${publicBase()}/login`,
  })
  const summary = [
    `New leads ${numbers.leads}`,
    `forms and chat ${numbers.forms}`,
    `calls answered ${numbers.callsAnswered}`,
    `missed calls texted ${numbers.callsMissed}`,
    `texts sent ${numbers.textsSent}`,
    `replies ${numbers.textsReceived}`,
    `appointments ${numbers.appointments}`,
    `review requests ${numbers.reviewRequests}`,
    `website ${siteHref(c.siteUrl!.trim())}`,
    `number ${pretty(a.numbers[0].number)}`,
  ].join('; ')
  let body = email.html
  try {
    const { trackClientReport } = await import('@/lib/disputes/receipts')
    body = await trackClientReport({
      clientId,
      to,
      by: o.by,
      subject: email.subject,
      html: email.html,
      summary,
      loginIncluded: !!login,
      loginEmail: login?.email ?? null,
    })
  } catch (err) {
    console.error('[client-report] evidence log failed:', err instanceof Error ? err.message : 'failed')
  }
  await sendEmail({
    accountEmail: process.env.AGENT_APPROVAL_FROM_EMAIL || (await getWriterAccountEmail()),
    fromName: 'Genisys',
    to,
    subject: email.subject,
    body,
  })
  const log = [...(await sentLog(clientId)), { at: new Date().toISOString(), to, by: o.by, login: !!login }].slice(-20)
  const key = LOG_KEY + clientId
  await prisma.appSetting.upsert({ where: { key }, create: { key, value: JSON.stringify(log) }, update: { value: JSON.stringify(log) } })
  console.log(`[client-report] ${o.by} emailed ${business}'s report to ${to}${login ? ' with a login link' : ''}`)
  return { ok: true, to, login: !!login }
}
