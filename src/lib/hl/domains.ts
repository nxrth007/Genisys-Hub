import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { HlInputError } from './http'
import {
  PorkbunError,
  checkDomains,
  createRecord,
  deleteRecord,
  dnsRecords,
  getNameservers,
  importDns,
  listRegistrarDomains,
  payHeldTransfer,
  prepareTransfer,
  quoteRegistration,
  quoteTransfer,
  registerDomain,
  releaseTransfer,
  scanDns,
  setNameservers,
  transferInfo,
  type DomainCheck,
  type Quote,
  type RegistrarDomain,
} from './porkbun'

/**
 * Client domains in Hell-level (GHL's Settings → Domains & URL Redirects),
 * held in the Hub's Porkbun account. Three ways in:
 *
 * - Buy: quote (a dry run gives the all-in price), the person confirms that
 *   exact price, then register with an idempotency key so a retry can't buy
 *   twice.
 * - Transfer in, e.g. from GoHighLevel: pay with holdForDnsSetup, which parks
 *   the transfer; build the zone here and copy what the domain's current DNS
 *   answers; the person reviews it, then releases the transfer. When the
 *   registry hands it over, the domain is already on working records, so the
 *   site and email don't go down.
 * - Link: a domain already in the Porkbun account.
 *
 * Money is only ever spent from a person's click on an exact price.
 */

export const LOVABLE_IP = '185.158.133.1' // Lovable's edge, docs.lovable.dev/features/custom-domain

type LogEntry = { at: string; by: string; what: string }

export function normalizeDomain(input: string): string | null {
  const s = input
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/^www\./, '')
    .replace(/\.$/, '')
  return /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(s) ? s : null
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

async function addLog(id: string, by: string, what: string, data: Prisma.HlDomainUpdateInput = {}) {
  const row = await prisma.hlDomain.findUnique({ where: { id }, select: { log: true } })
  const log = [...((row?.log as LogEntry[] | null) ?? []), { at: new Date().toISOString(), by, what }].slice(-100)
  return prisma.hlDomain.update({ where: { id }, data: { ...data, log: log as unknown as Prisma.InputJsonValue } })
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const TLDS = ['com', 'net', 'co', 'us', 'org', 'pro', 'biz', 'info', 'services', 'company']

/** What to look up for a search: the exact name if it has a dot, else the name across common endings plus a few .com variations. */
export function searchCandidates(term: string, city?: string | null): string[] {
  const exact = normalizeDomain(term)
  const slug = term
    .toLowerCase()
    .replace(/\.[a-z]{2,}$/, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '')
  if (!slug) return exact ? [exact] : []
  const citySlug = (city ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const names = [
    ...(exact ? [exact] : []),
    ...TLDS.map((t) => `${slug}.${t}`),
    ...(citySlug && !slug.includes(citySlug) ? [`${slug}${citySlug}.com`] : []),
    `get${slug}.com`,
    `${slug}co.com`,
    `${slug}llc.com`,
  ]
  return [...new Set(names)].filter((n) => normalizeDomain(n) === n).slice(0, 25)
}

export async function searchDomains(term: string, city?: string | null): Promise<DomainCheck[]> {
  const names = searchCandidates(term, city)
  if (!names.length) throw new HlInputError('Type a name to look for, like “acmeroofing” or “acmeroofing.com”.')
  const results = await checkDomains(names)
  const linked = new Set((await prisma.hlDomain.findMany({ where: { name: { in: names } }, select: { name: true } })).map((d) => d.name))
  return results.map((r) => (linked.has(r.name) ? { ...r, available: false, inYourAccount: true } : r))
}

// ---------------------------------------------------------------------------
// Buy
// ---------------------------------------------------------------------------

export async function quoteBuy(name: string): Promise<Quote & { name: string }> {
  const domain = normalizeDomain(name)
  if (!domain) throw new HlInputError('That isn’t a domain name.')
  return { name: domain, ...(await quoteRegistration(domain)) }
}

export async function buyDomain(o: { accountId: string; name: string; costCents: number; by: string }) {
  const domain = normalizeDomain(o.name)
  if (!domain) throw new HlInputError('That isn’t a domain name.')
  if (!Number.isInteger(o.costCents) || o.costCents <= 0) throw new HlInputError('Missing the price you agreed to.')
  if (await prisma.hlDomain.findUnique({ where: { name: domain } })) throw new HlInputError(`${domain} is already in Hell-level.`)
  // Re-quote: what's charged is what the person saw, or nothing.
  const quote = await quoteRegistration(domain)
  if (!quote.wouldSucceed) throw new HlInputError(quote.reason ?? `Porkbun won’t register ${domain} right now.`)
  if (quote.costCents !== o.costCents) throw new HlInputError(`The price is now ${money(quote.costCents)} (it was ${money(o.costCents)}). Check it and buy again.`)
  // The row first: its unique name stops a second click racing this one.
  const row = await prisma.hlDomain.create({ data: { accountId: o.accountId, name: domain, origin: 'bought', status: 'pending', costCents: o.costCents, createdBy: o.by } })
  try {
    const r = await registerDomain(domain, o.costCents, `hl-buy-${row.id}`)
    await addLog(row.id, o.by, `Bought for ${money(r.costCents)}`, { status: 'active', orderId: r.orderId, costCents: r.costCents, lastError: null })
  } catch (err) {
    if (err instanceof PorkbunError && err.code !== 'NETWORK') {
      // Porkbun said no, so nothing was bought.
      await prisma.hlDomain.delete({ where: { id: row.id } })
      throw new HlInputError(err.message)
    }
    // No answer: it may have gone through. Retrying replays the same order (idempotency key), never a second one.
    await addLog(row.id, o.by, `Purchase didn’t get an answer: ${errText(err)}`, { status: 'failed', lastError: 'Porkbun didn’t answer. Press “Check again”: it won’t buy twice.' })
    throw err
  }
  await refreshFromRegistrar([row.id]).catch(() => {})
  console.log(`[hell-level] ${o.by} bought ${domain} for ${money(o.costCents)} (account ${o.accountId})`)
  return prisma.hlDomain.findUniqueOrThrow({ where: { id: row.id } })
}

/** A purchase that got no answer: ask again with the same idempotency key (a replay if it went through). */
export async function retryPurchase(id: string, by: string) {
  const row = await prisma.hlDomain.findUniqueOrThrow({ where: { id } })
  if (row.origin !== 'bought' || row.status !== 'failed' || !row.costCents) throw new HlInputError('Nothing to retry.')
  const inAccount = (await listRegistrarDomains()).some((d) => d.name === row.name)
  if (inAccount) return addLog(id, by, 'Found it in the Porkbun account: the purchase went through', { status: 'active', lastError: null })
  try {
    const r = await registerDomain(row.name, row.costCents, `hl-buy-${row.id}`)
    return addLog(id, by, `Bought for ${money(r.costCents)}`, { status: 'active', orderId: r.orderId, lastError: null })
  } catch (err) {
    if (err instanceof PorkbunError && err.code !== 'NETWORK') {
      await prisma.hlDomain.delete({ where: { id } })
      throw new HlInputError(`${err.message} Nothing was bought.`)
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Link
// ---------------------------------------------------------------------------

/** Domains in the Porkbun account that no sub-account has yet. */
export async function unlinkedRegistrarDomains(): Promise<RegistrarDomain[]> {
  const [all, linked] = await Promise.all([listRegistrarDomains(), prisma.hlDomain.findMany({ select: { name: true } })])
  const taken = new Set(linked.map((d) => d.name))
  return all.filter((d) => !taken.has(d.name))
}

export async function linkDomain(o: { accountId: string; name: string; by: string }) {
  const domain = normalizeDomain(o.name)
  if (!domain) throw new HlInputError('That isn’t a domain name.')
  const existing = await prisma.hlDomain.findUnique({ where: { name: domain }, include: { account: { select: { name: true } } } })
  if (existing) throw new HlInputError(`${domain} is already linked to ${existing.account.name}.`)
  const found = (await listRegistrarDomains()).find((d) => d.name === domain)
  if (!found) throw new HlInputError(`${domain} isn’t in the Porkbun account. Buy it or transfer it in instead.`)
  const row = await prisma.hlDomain.create({
    data: {
      accountId: o.accountId,
      name: domain,
      origin: 'linked',
      status: 'active',
      expiresAt: found.expiresAt,
      autoRenew: found.autoRenew,
      createdBy: o.by,
      log: [{ at: new Date().toISOString(), by: o.by, what: 'Linked from the Porkbun account' }] as unknown as Prisma.InputJsonValue,
    },
  })
  return row
}

// ---------------------------------------------------------------------------
// Transfer in
// ---------------------------------------------------------------------------

export type TransferCheck = {
  name: string
  inPorkbun: boolean
  linkedTo: string | null
  available: boolean
  transferCents: number | null
  records: { host: string; type: string; content: string }[]
  scanError: string | null
}

/** Before asking for the auth code: is it transferable here, what it costs, and what its DNS is now (what gets copied). */
export async function checkTransfer(name: string): Promise<TransferCheck> {
  const domain = normalizeDomain(name)
  if (!domain) throw new HlInputError('That isn’t a domain name.')
  const linked = await prisma.hlDomain.findUnique({ where: { name: domain }, include: { account: { select: { name: true } } } })
  const [check] = await checkDomains([domain])
  let records: TransferCheck['records'] = []
  let scanError: string | null = null
  try {
    records = (await scanDns(domain)).map((r) => ({ host: r.host, type: r.type, content: r.content }))
  } catch (err) {
    scanError = errText(err)
  }
  return {
    name: domain,
    inPorkbun: !!check?.inYourAccount,
    linkedTo: linked?.account.name ?? null,
    available: !!check?.available,
    transferCents: check?.transferCents ?? null,
    records,
    scanError,
  }
}

export async function quoteTransferIn(name: string, authCode: string): Promise<Quote & { name: string }> {
  const domain = normalizeDomain(name)
  if (!domain) throw new HlInputError('That isn’t a domain name.')
  if (!authCode.trim()) throw new HlInputError('Paste the transfer (EPP) code from GoHighLevel.')
  return { name: domain, ...(await quoteTransfer(domain, authCode.trim())) }
}

/** Pay for the transfer, held, and get the DNS copied. The person then reviews and releases it (releaseHeldTransfer). */
export async function startTransferIn(o: { accountId: string; name: string; authCode: string; costCents: number; by: string }) {
  const domain = normalizeDomain(o.name)
  const authCode = o.authCode.trim()
  if (!domain) throw new HlInputError('That isn’t a domain name.')
  if (!authCode) throw new HlInputError('Paste the transfer (EPP) code from GoHighLevel.')
  if (!Number.isInteger(o.costCents) || o.costCents <= 0) throw new HlInputError('Missing the price you agreed to.')
  if (await prisma.hlDomain.findUnique({ where: { name: domain } })) throw new HlInputError(`${domain} is already in Hell-level.`)
  const quote = await quoteTransfer(domain, authCode)
  if (!quote.wouldSucceed) throw new HlInputError(quote.reason ?? `Porkbun won’t take ${domain} in right now.`)
  if (quote.costCents !== o.costCents) throw new HlInputError(`The transfer is now ${money(quote.costCents)} (it was ${money(o.costCents)}). Check it and start again.`)
  const row = await prisma.hlDomain.create({ data: { accountId: o.accountId, name: domain, origin: 'transfer', status: 'pending', costCents: o.costCents, createdBy: o.by } })
  try {
    const r = await payHeldTransfer(domain, authCode, o.costCents, `hl-transfer-${row.id}`)
    await addLog(row.id, o.by, `Transfer paid (${money(o.costCents)}, adds a year) and held while the DNS is copied`, { status: 'held', orderId: r.orderId, transferStatus: 'PENDINGDNS', lastError: null })
  } catch (err) {
    if (err instanceof PorkbunError && err.code !== 'NETWORK') {
      await prisma.hlDomain.delete({ where: { id: row.id } })
      throw new HlInputError(err.message)
    }
    await addLog(row.id, o.by, `Transfer payment didn’t get an answer: ${errText(err)}`, { status: 'failed', lastError: 'Porkbun didn’t answer. Check the Porkbun account’s transfers before trying again.' })
    throw err
  }
  console.log(`[hell-level] ${o.by} started a transfer of ${domain} for ${money(o.costCents)} (account ${o.accountId})`)
  await copyDnsForTransfer(row.id, o.by)
  return prisma.hlDomain.findUniqueOrThrow({ where: { id: row.id } })
}

/** Build the zone for a held transfer and copy the current DNS into it. Safe to run again. */
export async function copyDnsForTransfer(id: string, by: string) {
  const row = await prisma.hlDomain.findUniqueOrThrow({ where: { id } })
  if (row.status !== 'held') throw new HlInputError('This domain isn’t waiting on its DNS.')
  try {
    const prep = await prepareTransfer(row.name)
    const imported = await importDns(row.name)
    const meta = { ...((row.meta as Record<string, unknown>) ?? {}), porkbunNameservers: prep.nameservers, imported }
    return await addLog(id, by, `Copied the current DNS: ${imported.created} record(s) added${imported.skipped ? `, ${imported.skipped} already there` : ''}${imported.failed ? `, ${imported.failed} failed` : ''}`, {
      meta: meta as Prisma.InputJsonValue,
      lastError: null,
    })
  } catch (err) {
    return addLog(id, by, `Copying the DNS failed: ${errText(err)}`, { lastError: `Copying the DNS failed: ${errText(err)}` })
  }
}

/** The person checked the copied records: hand the transfer to the registry. */
export async function releaseHeldTransfer(id: string, by: string) {
  const row = await prisma.hlDomain.findUniqueOrThrow({ where: { id } })
  if (row.status !== 'held') throw new HlInputError('This transfer isn’t waiting to be released.')
  const records = await dnsRecords(row.name)
  if (!records.length) throw new HlInputError('The DNS here is empty, so the site and email would stop when the domain moves. Add the records first.')
  await releaseTransfer(row.name)
  return addLog(id, by, 'Released to the registry. GoHighLevel has up to 5 days to let it go (usually less).', { status: 'transferring', transferStatus: 'PENDINGTRANSFER', lastError: null })
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x))

/** Where a transfer stands; finishes it off when the registry is done. */
export async function refreshTransfer(id: string, by = 'hell-level') {
  const row = await prisma.hlDomain.findUniqueOrThrow({ where: { id } })
  if (row.status !== 'transferring' && row.status !== 'held') return row
  const t = await transferInfo(row.name)
  if (!t.status || t.status === row.transferStatus) return row
  if (t.status === 'DONE') {
    await addLog(id, by, 'Transfer complete: the domain is in the Porkbun account', { status: 'active', transferStatus: 'DONE', lastError: null })
    // Make sure it answers from the zone built here.
    const want = ((row.meta as Record<string, unknown>)?.porkbunNameservers as string[] | undefined) ?? []
    if (want.length) {
      try {
        const have = await getNameservers(row.name)
        if (!sameSet(have, want)) {
          await setNameservers(row.name, want)
          await addLog(id, by, `Nameservers set to Porkbun’s (${want.join(', ')})`)
        }
      } catch (err) {
        await addLog(id, by, `Couldn’t check the nameservers: ${errText(err)}`, { lastError: 'Check the nameservers: they should be Porkbun’s.' })
      }
    }
    await refreshFromRegistrar([id]).catch(() => {})
  } else if (t.status === 'CANCELED') {
    await addLog(id, by, `Transfer cancelled${t.description ? `: ${t.description}` : ''}`, { status: 'failed', transferStatus: t.status, lastError: t.description ?? 'The transfer was cancelled. Check the domain is unlocked in GoHighLevel and the code is current, then start again.' })
  } else {
    const waiting =
      t.status === 'PENDINGAUTH' ? 'Waiting on the transfer code. If it was mistyped or expired, get a new one from GoHighLevel and enter it here.' : null
    await addLog(id, by, `Transfer status: ${t.status}${t.description ? ` (${t.description})` : ''}`, { transferStatus: t.status, lastError: waiting })
  }
  return prisma.hlDomain.findUniqueOrThrow({ where: { id } })
}

// ---------------------------------------------------------------------------
// Keeping rows current
// ---------------------------------------------------------------------------

/** Expiry and auto-renew from the registrar for these rows (all active ones when none are given). */
export async function refreshFromRegistrar(ids?: string[]): Promise<number> {
  const rows = await prisma.hlDomain.findMany({ where: ids ? { id: { in: ids } } : { status: 'active' }, select: { id: true, name: true } })
  if (!rows.length) return 0
  const byName = new Map((await listRegistrarDomains()).map((d) => [d.name, d]))
  let n = 0
  for (const r of rows) {
    const d = byName.get(r.name)
    if (!d) continue
    await prisma.hlDomain.update({ where: { id: r.id }, data: { expiresAt: d.expiresAt, autoRenew: d.autoRenew } })
    n++
  }
  return n
}

let lastTransferSweep = 0
let lastRegistrarSweep = 0

/** From the scheduler: transfers every 30 minutes, expiry dates twice a day. */
export async function maybeRefreshDomains(): Promise<number> {
  let changed = 0
  if (Date.now() - lastTransferSweep >= 30 * 60_000) {
    lastTransferSweep = Date.now()
    const moving = await prisma.hlDomain.findMany({ where: { status: 'transferring' }, select: { id: true, transferStatus: true } })
    for (const m of moving) {
      try {
        const after = await refreshTransfer(m.id)
        if (after.transferStatus !== m.transferStatus) changed++
      } catch (err) {
        console.warn(`[hell-level] domain transfer check ${m.id}:`, errText(err))
      }
    }
  }
  if (Date.now() - lastRegistrarSweep >= 12 * 3600_000) {
    lastRegistrarSweep = Date.now()
    if (await prisma.hlDomain.count({ where: { status: 'active' } })) await refreshFromRegistrar().catch((err) => console.warn('[hell-level] domain expiry refresh:', errText(err)))
  }
  return changed
}

// ---------------------------------------------------------------------------
// Pointing a domain at the client's Lovable site
// ---------------------------------------------------------------------------

/**
 * Lovable's records (Project → Settings → Domains → Connect domain → manual):
 * A @ and www to Lovable's IP, and the _lovable TXT value it shows for each.
 * What would fight them at @ and www (other A/AAAA/CNAME/ALIAS) goes first.
 */
export async function connectLovable(id: string, o: { rootTxt: string; wwwTxt?: string | null; by: string }) {
  const row = await prisma.hlDomain.findUniqueOrThrow({ where: { id } })
  const rootTxt = o.rootTxt.trim()
  const wwwTxt = o.wwwTxt?.trim() || null
  if (!rootTxt.startsWith('lovable_verify=')) throw new HlInputError('Paste the TXT value Lovable shows: it starts with “lovable_verify=”.')
  if (wwwTxt && !wwwTxt.startsWith('lovable_verify=')) throw new HlInputError('The www TXT value should start with “lovable_verify=” too.')
  const records = await dnsRecords(row.name)
  const removed: string[] = []
  for (const r of records) {
    if ((r.host === '' || r.host === 'www') && ['A', 'AAAA', 'CNAME', 'ALIAS'].includes(r.type) && !(r.type === 'A' && r.content === LOVABLE_IP)) {
      await deleteRecord(row.name, r.id)
      removed.push(`${r.type} ${r.host || '@'} → ${r.content}`)
    }
  }
  const has = (host: string, type: string, content: string) => records.some((r) => r.host === host && r.type === type && r.content === content)
  const wanted: { host: string; type: string; content: string }[] = [
    { host: '', type: 'A', content: LOVABLE_IP },
    { host: 'www', type: 'A', content: LOVABLE_IP },
    { host: '_lovable', type: 'TXT', content: rootTxt },
    ...(wwwTxt ? [{ host: '_lovable.www', type: 'TXT', content: wwwTxt }] : []),
  ]
  for (const w of wanted) if (!has(w.host, w.type, w.content)) await createRecord(row.name, { ...w, ttl: 600 })
  return addLog(id, o.by, `Pointed at the Lovable site${removed.length ? ` (replaced ${removed.join('; ')})` : ''}. Press Verify in Lovable once DNS has updated (minutes to a few hours).`)
}
