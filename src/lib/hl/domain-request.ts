/**
 * A new client's website domain, asked for in the Office (Alex, 2026-11-13:
 * "suggest 3 it can purchase for a client inside of the office").
 *
 * Right after onboarding makes the client's Hell-level sub-account, Forge
 * (the website-build bot) checks Porkbun for domains from the business name
 * (./domain-plan.ts) and asks: buy one of these three? Each shows Porkbun's
 * all-in first-year price. The one a person presses is bought right away into
 * the client's sub-account (./domains.ts buyDomain: re-quoted, the exact
 * price or nothing, never twice). "None of these" drops the question; their
 * Hell-level Settings → Domains searches any name. Buying costs money, so it
 * never happens without that press. A client bringing their own domain (the
 * onboarding form says so) isn't asked.
 */
import { Prisma } from '@/generated/prisma/client'
import { hubLink } from '@/lib/hub-alerts'
import { prisma } from '@/lib/prisma'
import { textDomainEvent } from '@/lib/ghl-subaccount-worker/alerts'
import { readProfile } from './accounts'
import { domainAskDecision, domainCandidates, pickDomainOptions, readChoices, yearly, type DomainChoice } from './domain-plan'
import { buyDomain } from './domains'
import { HlInputError } from './http'
import { checkDomains, PorkbunError, quoteRegistration } from './porkbun'

const SINCE_KEY = 'hlDomain.since'
const SWEEP_EVERY_MS = 10 * 60_000
const STUCK_BUYING_MS = 10 * 60_000

type LogEntry = { at: string; what: string }
const describe = (err: unknown) => (err instanceof Error ? err.message : String(err))
const domainsPage = (accountId: string) => hubLink(`/hell-level/${accountId}/settings?tab=domains`)

/** When the domain question started: the sweep only asks sub-accounts made since. */
async function domainSince(now = new Date()): Promise<Date> {
  const row = await prisma.appSetting.findUnique({ where: { key: SINCE_KEY } })
  if (row?.value && !Number.isNaN(Date.parse(row.value))) return new Date(row.value)
  try {
    await prisma.appSetting.create({ data: { key: SINCE_KEY, value: now.toISOString() } })
  } catch {
    // Another process recorded it first.
  }
  const again = await prisma.appSetting.findUnique({ where: { key: SINCE_KEY } })
  return new Date(again?.value && !Number.isNaN(Date.parse(again.value)) ? again.value : now.toISOString())
}

async function note(id: string, what: string, data: Prisma.HlDomainRequestUpdateInput = {}) {
  const row = await prisma.hlDomainRequest.findUnique({ where: { id }, select: { log: true } })
  const log = [...((row?.log as LogEntry[] | null) ?? []), { at: new Date().toISOString(), what }].slice(-40)
  await prisma.hlDomainRequest.update({ where: { id }, data: { ...data, log: log as unknown as Prisma.InputJsonValue } })
}

/** The first city they serve (Business Profile's service area, else onboarding), else the city in the profile's address. */
function cityOf(cities: string | null | undefined, address: string | null | undefined): string | null {
  const first = (cities ?? '').split(/[,\n;]/)[0]?.trim()
  if (first) return first
  const parts = (address ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return parts.length >= 3 ? parts[parts.length - 2] : null
}

/** Three available domains with Porkbun's all-in prices, and anything Porkbun said that a person should know. */
export async function suggestDomains(businessName: string, city: string | null): Promise<{ choices: DomainChoice[]; warning: string | null }> {
  const names = domainCandidates(businessName, city)
  if (!names.length) return { choices: [], warning: `“${businessName}” doesn’t make a domain name.` }
  const [checks, ours] = await Promise.all([checkDomains(names), prisma.hlDomain.findMany({ where: { name: { in: names } }, select: { name: true } })])
  const taken = new Set(ours.map((d) => d.name))
  const picks = pickDomainOptions(
    names,
    checks.map((c) => ({ ...c, inYourAccount: c.inYourAccount || taken.has(c.name) })),
  )
  let warning: string | null = null
  const choices: DomainChoice[] = []
  for (const p of picks) {
    // The all-in price Porkbun would charge (a dry run), which is what buying takes.
    const q = await quoteRegistration(p.name).catch((err) => ({ costCents: 0, wouldSucceed: false, reason: describe(err) }))
    if (!q.wouldSucceed && q.reason) warning = `Porkbun: ${q.reason}`
    choices.push({ name: p.name, costCents: q.costCents > 0 ? q.costCents : (p.priceCents ?? 0), renewalCents: p.renewalCents })
  }
  return { choices: choices.filter((c) => c.costCents > 0), warning }
}

export type DomainAskResult = { ok: true; status: string; id: string } | { ok: false; reason: string }

/**
 * Put Forge's question in the Office for this client, if it should be asked (./domain-plan.ts).
 * `refresh` (by hand, from their folder): fresh suggestions for a question that's still open.
 */
export async function askForClientDomain(clientId: string, trigger: 'onboarding' | 'sweep' | 'manual', opts: { refresh?: boolean } = {}): Promise<DomainAskResult> {
  const c = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      name: true,
      archivedAt: true,
      siteUrl: true,
      hlAccount: { select: { id: true, createdAt: true, profile: true, archivedAt: true } },
      hlDomainRequest: { select: { id: true, status: true } },
      intakes: { orderBy: { receivedAt: 'desc' }, take: 1, select: { bringingOwnDomain: true, cities: true } },
    },
  })
  if (!c) return { ok: false, reason: 'client not found' }
  const account = c.hlAccount && !c.hlAccount.archivedAt ? c.hlAccount : null
  const hasDomain = account ? (await prisma.hlDomain.count({ where: { accountId: account.id, status: { not: 'failed' } } })) > 0 : false
  const decision = domainAskDecision({
    archived: !!c.archivedAt,
    accountId: account?.id ?? null,
    bringingOwnDomain: /^y(es)?$/i.test(c.intakes[0]?.bringingOwnDomain?.trim() ?? ''),
    hasDomain,
    siteLive: !!c.siteUrl?.trim(),
    request: c.hlDomainRequest,
    trigger,
    accountCreatedAt: account?.createdAt ?? null,
    since: await domainSince(),
    refresh: opts.refresh,
  })
  if (!decision.ask || !account) return { ok: false, reason: decision.reason }
  const profile = readProfile(account.profile)
  const business = profile.businessName || c.name
  let found: Awaited<ReturnType<typeof suggestDomains>>
  try {
    found = await suggestDomains(business, cityOf(profile.serviceArea?.trim() || c.intakes[0]?.cities, profile.address))
  } catch (err) {
    // Porkbun not connected or not answering: the question still goes in, pointing at a search by hand.
    found = { choices: [], warning: describe(err) }
  }
  const detail = found.choices.length
    ? found.warning
    : `No available domain under ${yearly(2500)} from “${business}”${found.warning ? ` (${found.warning})` : ''}. Search any name in their Hell-level → Settings → Domains.`
  const how = trigger !== 'manual' ? 'the client just onboarded' : c.hlDomainRequest?.status === 'awaiting_approval' ? 'fresh suggestions, by hand' : 'by hand'
  const what = `Asked in the Office (${how}): ${found.choices.map((x) => `${x.name} ${yearly(x.costCents)}`).join(', ') || 'no suggestions'}.`
  const data = {
    accountId: account.id,
    status: 'awaiting_approval',
    suggestions: found.choices as unknown as Prisma.InputJsonValue,
    name: null,
    domainId: null,
    costCents: null,
    detail,
    trigger,
    decidedBy: null,
    decidedAt: null,
    log: [{ at: new Date().toISOString(), what }] as unknown as Prisma.InputJsonValue,
  }
  const row = c.hlDomainRequest
    ? await prisma.hlDomainRequest.update({ where: { id: c.hlDomainRequest.id }, data, select: { id: true } })
    : await prisma.hlDomainRequest.create({ data: { clientId, ...data }, select: { id: true } })
  // A text for a question the Hub asked by itself; whoever asks by hand is already looking.
  const cheapest = found.choices.length ? Math.min(...found.choices.map((x) => x.costCents)) : null
  if (trigger !== 'manual') await textDomainEvent({ key: row.id, kind: 'pick', client: c.name, reason: cheapest ? `from ${yearly(cheapest)}` : '', link: hubLink('/office') })
  return { ok: true, status: 'awaiting_approval', id: row.id }
}

export type DomainDecision = { ok: true; status: string; detail: string | null } | { ok: false; reason: string }

/**
 * A person's answer in the Office: buy one of the suggestions (`name`), or
 * none of these. Buying goes through buyDomain, which re-quotes and charges
 * the price shown or nothing.
 */
export async function decideClientDomain(id: string, decision: 'buy' | 'no', name: string | null, by: string): Promise<DomainDecision> {
  const r = await prisma.hlDomainRequest.findUnique({ where: { id }, include: { client: { select: { name: true } } } })
  if (!r) return { ok: false, reason: 'That question is gone.' }
  if (r.status !== 'awaiting_approval') return { ok: false, reason: r.status === 'buying' ? 'It’s already buying one.' : 'That question was already answered.' }
  if (decision === 'no') {
    await note(r.id, `${by} answered None of these.`, { status: 'declined', decidedBy: by, decidedAt: new Date(), detail: null })
    return { ok: true, status: 'declined', detail: 'No domain bought. Search any name in their Hell-level → Settings → Domains.' }
  }
  const choice = readChoices(r.suggestions).find((x) => x.name === name)
  if (!choice) return { ok: false, reason: 'Pick one of the suggested domains.' }
  // Only one press buys: the status moves first.
  const claimed = await prisma.hlDomainRequest.updateMany({ where: { id: r.id, status: 'awaiting_approval' }, data: { status: 'buying', name: choice.name, decidedBy: by, decidedAt: new Date() } })
  if (!claimed.count) return { ok: false, reason: 'Someone else just answered it.' }
  try {
    const d = await buyDomain({ accountId: r.accountId, name: choice.name, costCents: choice.costCents, by })
    const detail = `Bought ${d.name} for $${((d.costCents ?? choice.costCents) / 100).toFixed(2)} on Porkbun. It’s in their Hell-level → Settings → Domains.`
    await note(r.id, `${by} picked ${d.name}. ${detail}`, { status: 'bought', domainId: d.id, costCents: d.costCents ?? choice.costCents, detail })
    return { ok: true, status: 'bought', detail }
  } catch (err) {
    // Porkbun not answering is the one case where the purchase may have gone through.
    const unknown = err instanceof PorkbunError && err.code === 'NETWORK'
    if (!unknown && err instanceof HlInputError) {
      // Nothing was bought (a new price, taken in the meantime, no credit): the question stays, with the fresh price.
      const fresh = await quoteRegistration(choice.name).catch(() => null)
      const suggestions = readChoices(r.suggestions).map((x) => (x.name === choice.name && fresh?.costCents ? { ...x, costCents: fresh.costCents } : x))
      const why = describe(err)
      await note(r.id, `${by} picked ${choice.name}; not bought: ${why}`, { status: 'awaiting_approval', name: null, decidedBy: null, decidedAt: null, detail: why, suggestions: suggestions as unknown as Prisma.InputJsonValue })
      return { ok: false, reason: why }
    }
    // No answer from Porkbun: it may have gone through. The domain's own row (Hell-level → Domains) checks again without buying twice.
    const detail = `Porkbun didn’t answer while buying ${choice.name}. Check it in their Hell-level → Settings → Domains (“Check again” never buys twice).`
    await note(r.id, `${by} picked ${choice.name}. ${detail}`, { status: 'failed', detail })
    await textDomainEvent({ key: r.id, kind: 'failed', client: r.client.name, reason: detail, link: domainsPage(r.accountId) })
    return { ok: false, reason: detail }
  }
}

let lastSweep = 0

/**
 * Every 10 minutes: ask about new sub-accounts the onboarding hook missed,
 * and settle a purchase a restart interrupted (by what Porkbun holds).
 */
export async function maybeSweepDomainRequests(now = Date.now()): Promise<number> {
  if (now - lastSweep < SWEEP_EVERY_MS) return 0
  lastSweep = now
  let changed = 0
  const since = await domainSince()
  const fresh = await prisma.client.findMany({
    where: { archivedAt: null, hlDomainRequest: { is: null }, hlAccount: { is: { createdAt: { gte: since }, archivedAt: null } } },
    select: { id: true },
    take: 10,
  })
  for (const c of fresh) {
    const res = await askForClientDomain(c.id, 'sweep').catch(() => null)
    if (res?.ok) changed += 1
  }
  const stuck = await prisma.hlDomainRequest.findMany({ where: { status: 'buying', updatedAt: { lt: new Date(now - STUCK_BUYING_MS) } }, select: { id: true, name: true } })
  for (const s of stuck) {
    const d = s.name ? await prisma.hlDomain.findUnique({ where: { name: s.name }, select: { id: true, status: true, costCents: true } }) : null
    if (d?.status === 'active') {
      await note(s.id, `${s.name} is on the sub-account (the purchase was interrupted, then found).`, { status: 'bought', domainId: d.id, costCents: d.costCents, detail: `Bought ${s.name}. It’s in their Hell-level → Settings → Domains.` })
    } else {
      await note(s.id, 'The purchase was interrupted.', { status: 'failed', detail: `The purchase of ${s.name ?? 'the domain'} was interrupted. Check their Hell-level → Settings → Domains before asking again.` })
    }
    changed += 1
  }
  return changed
}
