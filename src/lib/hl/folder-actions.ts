/**
 * The buttons in a client's Sites folder (Alex, 2026-11-14): pick a domain from Porkbun's
 * suggestions, buy their Hell-level toll-free number, build their website. Each press is the
 * person's Yes to what the Office asks, so it goes through the Office's own functions: the same
 * prices, the same "only one press buys" claims, logs and texts. A question already open in the
 * Office is answered, never asked twice. ./folder-plan.ts says which buttons apply; it is checked
 * again here, so a stale page can't buy what the folder wouldn't offer.
 */
import { askView } from '@/lib/ghl-number/census-plan'
import { prisma } from '@/lib/prisma'
import { lovableMcpStatus } from '@/lib/seo/lovable-mcp'
import { readChoices, type DomainChoice } from './domain-plan'
import { askForClientDomain, decideClientDomain } from './domain-request'
import { folderBuild, folderDomain, folderNumber } from './folder-plan'
import { askForClientNumber, decideClientNumber } from './number-request'
import { siteQuestionDetail } from './site-plan'
import { askForClientSite, decideClientSite, gatherSite } from './site-request'

export type FolderResult = { ok: true; status: string; detail: string | null } | { ok: false; reason: string }

const sentence = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? '' : '.'}`

/** What a build would use (photos, domain, phone) and what stops it, before anyone spends anything. */
export async function sitePreflight(clientId: string): Promise<{ text: string; missing: string[] }> {
  const g = await gatherSite(clientId)
  if (!g) return { text: 'They have no Hell-level sub-account, which the site’s form and chat need.', missing: ['Hell-level sub-account'] }
  const text = siteQuestionDetail(
    { photos: g.facts.photos.length, skipped: g.facts.skipped.length, domain: g.facts.domain, phoneSource: g.facts.phoneSource, numberAsked: g.numberAsked, domainAsked: g.domainAsked, missing: g.missing },
    'folder',
  )
  return { text, missing: g.missing }
}

/**
 * Build their website now. `overrideGhl` is the person agreeing, for a client set up in GHL, that
 * the site gets Hell-level's form and chat.
 */
export async function buildSiteNow(clientId: string, by: string, overrideGhl: boolean): Promise<FolderResult> {
  const c = await prisma.client.findUnique({
    where: { id: clientId },
    select: { archivedAt: true, ghlLocationId: true, hlAccount: { select: { archivedAt: true } }, hlSiteRequest: { select: { id: true, status: true } } },
  })
  if (!c || c.archivedAt) return { ok: false, reason: 'This client is archived or gone.' }
  const plan = folderBuild({ hasAccount: !!c.hlAccount && !c.hlAccount.archivedAt, ghlLinked: !!c.ghlLocationId, status: c.hlSiteRequest?.status ?? null })
  if (plan.kind === 'none') return { ok: false, reason: plan.reason }
  if (plan.overrideGhl && !overrideGhl) return { ok: false, reason: 'They’re set up in GHL: confirm building with Hell-level’s form and chat.' }
  // Before anything is asked or spent.
  const lovable = await lovableMcpStatus()
  if (!lovable.connected) return { ok: false, reason: 'The Hub isn’t signed in to Lovable. Connect it on the SEO page (Setup card), then press Build site again.' }
  const pre = await sitePreflight(clientId)
  if (pre.missing.length) return { ok: false, reason: pre.text }
  let id = plan.answersOffice ? c.hlSiteRequest!.id : null
  if (!id) {
    const asked = await askForClientSite(clientId, 'manual', { overrideGhl: plan.overrideGhl, by })
    if (!asked.ok) return { ok: false, reason: sentence(asked.reason) }
    id = asked.id
  }
  return decideClientSite(id, 'build', by)
}

/** Buy their Hell-level toll-free number now, on Genisys's Twilio. */
export async function buyNumberNow(clientId: string, by: string): Promise<FolderResult> {
  const c = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      archivedAt: true,
      ghlLocationId: true,
      ghlNumberCensus: { select: { locationId: true, state: true, version: true } },
      hlAccount: { select: { archivedAt: true, numbers: { where: { status: 'active', kind: 'toll_free' }, select: { id: true } } } },
      hlNumberRequest: { select: { id: true, status: true } },
    },
  })
  if (!c || c.archivedAt) return { ok: false, reason: 'This client is archived or gone.' }
  const plan = folderNumber({
    hasAccount: !!c.hlAccount && !c.hlAccount.archivedAt,
    hasTollFree: !!c.hlAccount?.numbers.length,
    ghlHasNumber: askView(c.ghlNumberCensus, c.ghlLocationId) === 'has',
    status: c.hlNumberRequest?.status ?? null,
  })
  if (plan.kind === 'none') return { ok: false, reason: plan.reason }
  let id = plan.answersOffice ? c.hlNumberRequest!.id : null
  if (!id) {
    const asked = await askForClientNumber(clientId, 'manual')
    if (!asked.ok) return { ok: false, reason: sentence(asked.reason) }
    id = asked.id
  }
  const res = await decideClientNumber(id, 'hl', by)
  return res.ok ? { ok: true, status: res.status, detail: res.detail ?? null } : res
}

/** Their domain question as the folder shows it. */
async function domainState(clientId: string) {
  const c = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      archivedAt: true,
      hlAccount: { select: { id: true, archivedAt: true } },
      hlDomainRequest: { select: { id: true, status: true, suggestions: true, name: true, detail: true } },
    },
  })
  if (!c || c.archivedAt) return null
  const account = c.hlAccount && !c.hlAccount.archivedAt ? c.hlAccount : null
  const hasDomain = account ? (await prisma.hlDomain.count({ where: { accountId: account.id, status: { not: 'failed' } } })) > 0 : false
  const r = c.hlDomainRequest
  return {
    request: r,
    plan: folderDomain({ hasAccount: !!account, hasDomain, status: r?.status ?? null, choices: readChoices(r?.suggestions), buying: r?.name ?? null }),
  }
}

/**
 * Three available domains from Porkbun for the business name (free: availability and a dry-run
 * price), as Forge's question in the Office; an open question gets fresh ones.
 */
export async function suggestDomainsNow(clientId: string): Promise<{ ok: true; detail: string | null; choices: DomainChoice[] } | { ok: false; reason: string }> {
  const s = await domainState(clientId)
  if (!s) return { ok: false, reason: 'This client is archived or gone.' }
  if (s.plan.kind === 'none') return { ok: false, reason: s.plan.reason }
  const asked = await askForClientDomain(clientId, 'manual', { refresh: s.request?.status === 'awaiting_approval' })
  if (!asked.ok) return { ok: false, reason: sentence(asked.reason) }
  const r = await prisma.hlDomainRequest.findUnique({ where: { id: asked.id }, select: { suggestions: true, detail: true } })
  return { ok: true, detail: r?.detail ?? null, choices: readChoices(r?.suggestions) }
}

/** Buy one of Forge's suggestions (re-quoted at Porkbun: the price shown or nothing, never twice). */
export async function buyDomainNow(clientId: string, name: string, by: string): Promise<FolderResult> {
  const s = await domainState(clientId)
  if (!s) return { ok: false, reason: 'This client is archived or gone.' }
  if (s.plan.kind === 'none') return { ok: false, reason: s.plan.reason }
  if (s.plan.kind !== 'choose' || !s.request) return { ok: false, reason: 'Find domains first, then pick one.' }
  if (!s.plan.choices.some((x) => x.name === name)) return { ok: false, reason: 'Pick one of the suggested domains (the list may have just changed).' }
  return decideClientDomain(s.request.id, 'buy', name, by)
}

/** None of these: drops the suggestions here and in the Office. */
export async function dropDomainsNow(clientId: string, by: string): Promise<FolderResult> {
  const s = await domainState(clientId)
  if (!s?.request || s.request.status !== 'awaiting_approval') return { ok: false, reason: 'There are no suggestions to drop.' }
  return decideClientDomain(s.request.id, 'no', null, by)
}
