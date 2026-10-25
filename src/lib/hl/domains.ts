import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { dnsProvider, publicRecords, resolve, splitHost } from './dns-lookup'
import { registration } from './rdap'
import { LOVABLE_IP, fqdnOf, metaOf, siteRecords, type DomainMeta, type HostConnection } from './domain-shared'
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

export { LOVABLE_IP, metaOf, siteRecords, type DomainMeta, type HostConnection } from './domain-shared'

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
  /** From the public registration record (null when the registry doesn't say). */
  registrar: string | null
  registeredAt: Date | null
  transferableFrom: Date | null
  transferableNow: boolean | null
  locked: boolean | null
}

/** Before asking for the auth code: is it transferable here (and from when), what it costs, and what its DNS is now (what gets copied). */
export async function checkTransfer(name: string): Promise<TransferCheck> {
  const domain = normalizeDomain(name)
  if (!domain) throw new HlInputError('That isn’t a domain name.')
  const linked = await prisma.hlDomain.findUnique({ where: { name: domain }, include: { account: { select: { name: true } } } })
  const [[check], reg] = await Promise.all([checkDomains([domain]), registration(domain).catch(() => null)])
  let records: TransferCheck['records'] = []
  let scanError: string | null = null
  try {
    records = (await scanDns(domain)).map((r) => ({ host: r.host, type: r.type, content: r.content }))
  } catch (err) {
    // Porkbun only scans domains already in the account (it does once the transfer is paid for); until then, read the live DNS here.
    try {
      records = await publicRecords(domain)
    } catch {
      scanError = errText(err)
    }
  }
  return {
    name: domain,
    inPorkbun: !!check?.inYourAccount,
    linkedTo: linked?.account.name ?? null,
    available: !!check?.available,
    transferCents: check?.transferCents ?? null,
    records,
    scanError,
    registrar: reg?.registrar ?? null,
    registeredAt: reg?.registeredAt ?? null,
    transferableFrom: reg?.transferableFrom ?? null,
    transferableNow: reg?.transferableFrom ? reg.transferableFrom.getTime() <= Date.now() : null,
    locked: reg ? reg.locked : null,
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

type LiveRecord = { host: string; type: string; content: string; prio: number | null }

/** A live record as a zone holds it: an MX's priority apart from its server. */
function asZone(r: { host: string; type: string; content: string }): LiveRecord {
  if (r.type !== 'MX') return { ...r, prio: null }
  const [prio, ...server] = r.content.split(/\s+/)
  return { host: r.host, type: 'MX', content: server.join(' '), prio: Number(prio) || 0 }
}

const sameValue = (a: string, b: string) => a.toLowerCase().replace(/\.$/, '') === b.toLowerCase().replace(/\.$/, '')

/**
 * For a parked transfer: what the domain answers with now on its usual names
 * that the copy here hasn't got. DNS can't be listed, so Porkbun's scan can
 * miss one, like the key GoHighLevel's email signs with.
 */
export async function missingFromCopy(name: string, zone: { host: string; type: string; content: string; prio: number | null }[]): Promise<LiveRecord[]> {
  const live = (await publicRecords(name)).map(asZone)
  return live.filter((r) => !zone.some((z) => z.host === r.host && z.type === r.type && sameValue(z.content, r.content) && (r.type !== 'MX' || z.prio === r.prio)))
}

/** Add what the copy was missing (missingFromCopy) to a parked transfer's DNS. */
export async function addMissingToCopy(id: string, by: string) {
  const row = await prisma.hlDomain.findUniqueOrThrow({ where: { id } })
  if (row.status !== 'held') throw new HlInputError('This domain isn’t waiting on its DNS.')
  const missing = await missingFromCopy(row.name, await dnsRecords(row.name))
  if (!missing.length) return row
  const r = await importDns(row.name, missing.map((m) => ({ ...m, ttl: null })))
  return addLog(id, by, `Added ${r.created} record(s) the copy was missing: ${missing.map((m) => `${m.type} ${m.host || '@'}`).join(', ')}`)
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
  const rows = await prisma.hlDomain.findMany({ where: ids ? { id: { in: ids }, origin: { not: 'external' } } : { status: 'active', origin: { not: 'external' } }, select: { id: true, name: true } })
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
    // Connections waiting on someone to add records at another DNS provider.
    const external = await prisma.hlDomain.findMany({ where: { origin: 'external', status: 'active' }, select: { id: true, meta: true } })
    for (const e of external) {
      if (!(metaOf(e.meta).hosts ?? []).some((h) => !h.verifiedAt)) continue
      await verifyExternal(e.id).catch((err) => console.warn(`[hell-level] external domain check ${e.id}:`, errText(err)))
    }
  }
  if (Date.now() - lastRegistrarSweep >= 12 * 3600_000) {
    lastRegistrarSweep = Date.now()
    if (await prisma.hlDomain.count({ where: { status: 'active', origin: { not: 'external' } } })) await refreshFromRegistrar().catch((err) => console.warn('[hell-level] domain expiry refresh:', errText(err)))
  }
  return changed
}

// ---------------------------------------------------------------------------
// Pointing a domain at the client's Lovable site
// ---------------------------------------------------------------------------

const checkTxt = (v: string | null | undefined, what: string) => {
  const t = v?.trim() || null
  if (t && !t.startsWith('lovable_verify=')) throw new HlInputError(`The ${what} value Lovable shows starts with “lovable_verify=”.`)
  return t
}

function withHost(meta: DomainMeta, c: HostConnection): DomainMeta {
  return { ...meta, hosts: [...(meta.hosts ?? []).filter((h) => h.host !== c.host), c].sort((a, b) => a.host.localeCompare(b.host)) }
}

/**
 * Lovable's records (Project → Settings → Domains → Connect domain → manual)
 * on a domain held here: A to Lovable's IP (the domain and www, or the
 * subdomain), and the _lovable TXT value it shows. What would fight them at
 * those names (other A/AAAA/CNAME/ALIAS) goes first.
 */
export async function connectLovable(id: string, o: { host?: string; rootTxt: string; wwwTxt?: string | null; by: string }) {
  const row = await prisma.hlDomain.findUniqueOrThrow({ where: { id } })
  const host = (o.host ?? '').toLowerCase()
  const rootTxt = checkTxt(o.rootTxt, 'TXT')
  const wwwTxt = host ? null : checkTxt(o.wwwTxt, 'www TXT')
  if (!rootTxt) throw new HlInputError('Paste the TXT value Lovable shows: it starts with “lovable_verify=”.')
  const names = host ? [host] : ['', 'www']
  const records = await dnsRecords(row.name)
  const removed: string[] = []
  for (const r of records) {
    if (names.includes(r.host) && ['A', 'AAAA', 'CNAME', 'ALIAS'].includes(r.type) && !(r.type === 'A' && r.content === LOVABLE_IP)) {
      await deleteRecord(row.name, r.id)
      removed.push(`${r.type} ${r.host || '@'} → ${r.content}`)
    }
  }
  const has = (h: string, type: string, content: string) => records.some((r) => r.host === h && r.type === type && r.content === content)
  for (const w of siteRecords({ host, txt: rootTxt, wwwTxt })) {
    const h = w.host === '@' ? '' : w.host
    if (!has(h, w.type, w.value)) await createRecord(row.name, { host: h, type: w.type, content: w.value, ttl: 600 })
  }
  const now = new Date().toISOString()
  const meta = withHost(metaOf(row.meta), { host, product: 'site', txt: rootTxt, wwwTxt, addedAt: now, verifiedAt: null })
  return addLog(id, o.by, `Pointed ${fqdnOf(row.name, host)} at the Lovable site${removed.length ? ` (replaced ${removed.join('; ')})` : ''}. Press Verify in Lovable once DNS has updated (minutes to a few hours).`, {
    meta: meta as Prisma.InputJsonValue,
  })
}

// ---------------------------------------------------------------------------
// Connect a domain (GHL's "Connect a domain"): one held here gets its records
// set; one registered elsewhere becomes an external domain with the records
// to add at its DNS provider, checked against public DNS.
// ---------------------------------------------------------------------------

/** "https://Try.Acme.com/x" → "try.acme.com" (subdomains kept, unlike normalizeDomain). */
export function normalizeHost(input: string): string | null {
  const s = input
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '')
  return normalizeDomain(s) ? s : /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s) ? s : null
}

export async function connectDomain(o: { accountId: string; name: string; txt?: string | null; wwwTxt?: string | null; by: string }) {
  const fqdn = normalizeHost(o.name)
  if (!fqdn) throw new HlInputError('Type the domain or subdomain, like acmeroofing.com or try.acmeroofing.com.')
  const split = splitHost(fqdn)
  const domain = split.domain
  // www.acme.com is the domain itself (its records include www).
  const host = split.host === 'www' ? '' : split.host
  const txt = checkTxt(o.txt, 'TXT')
  const wwwTxt = host ? null : checkTxt(o.wwwTxt, 'www TXT')
  const existing = await prisma.hlDomain.findUnique({ where: { name: domain }, include: { account: { select: { name: true } } } })
  if (existing && existing.accountId !== o.accountId) throw new HlInputError(`${domain} belongs to ${existing.account.name}.`)
  if (existing && existing.origin !== 'external') {
    if (existing.status !== 'active' && existing.status !== 'held') throw new HlInputError(`${domain} isn’t ready yet (${existing.status}).`)
    if (!txt) throw new HlInputError('Paste the TXT value Lovable shows for it (it starts with “lovable_verify=”), and the records are set here.')
    return { domain: await connectLovable(existing.id, { host, rootTxt: txt, wwwTxt, by: o.by }), internal: true }
  }
  const now = new Date().toISOString()
  let meta = withHost(metaOf(existing?.meta), { host, product: 'site', txt, wwwTxt, addedAt: now, verifiedAt: null, lastCheck: null })
  try {
    const p = await dnsProvider(domain)
    meta = { ...meta, provider: p.provider, nameservers: p.nameservers }
  } catch {
    // provider shown as unknown until the next check
  }
  const row = existing
    ? await addLog(existing.id, o.by, `Connected ${fqdnOf(domain, host)} to the website`, { meta: meta as Prisma.InputJsonValue })
    : await prisma.hlDomain.create({
        data: {
          accountId: o.accountId,
          name: domain,
          origin: 'external',
          status: 'active',
          meta: meta as Prisma.InputJsonValue,
          createdBy: o.by,
          log: [{ at: now, by: o.by, what: `Connected ${fqdnOf(domain, host)} to the website (DNS stays where it is)` }] as unknown as Prisma.InputJsonValue,
        },
      })
  return { domain: await verifyExternal(row.id), internal: false }
}

/** Look up each connected host's records in public DNS. */
export async function verifyExternal(id: string) {
  const row = await prisma.hlDomain.findUniqueOrThrow({ where: { id } })
  const meta = metaOf(row.meta)
  const hosts: HostConnection[] = []
  for (const h of meta.hosts ?? []) {
    const fqdn = fqdnOf(row.name, h.host)
    try {
      const a = await resolve(fqdn, 'A')
      const wwwOk = h.host ? true : (await resolve(`www.${row.name}`, 'A')).includes(LOVABLE_IP)
      const txtOk = h.txt ? (await resolve(h.host ? `_lovable.${fqdn}` : `_lovable.${row.name}`, 'TXT')).includes(h.txt) : true
      const ok = a.includes(LOVABLE_IP) && wwwOk && txtOk
      const at = new Date().toISOString()
      hosts.push({ ...h, lastCheck: { at, ok, a, txtOk }, verifiedAt: ok ? (h.verifiedAt ?? at) : null })
    } catch {
      hosts.push(h)
    }
  }
  let next: DomainMeta = { ...meta, hosts }
  if (row.origin === 'external') {
    try {
      const p = await dnsProvider(row.name)
      next = { ...next, provider: p.provider, nameservers: p.nameservers }
    } catch {
      // keep what we had
    }
  }
  return prisma.hlDomain.update({ where: { id }, data: { meta: next as Prisma.InputJsonValue } })
}

export async function disconnectHost(id: string, host: string, by: string) {
  const row = await prisma.hlDomain.findUniqueOrThrow({ where: { id } })
  const meta = metaOf(row.meta)
  const next = { ...meta, hosts: (meta.hosts ?? []).filter((h) => h.host !== host) }
  return addLog(id, by, `Disconnected ${fqdnOf(row.name, host)} from the website${row.origin === 'external' ? ' (its DNS records stay where they are; remove them there)' : ''}`, { meta: next as Prisma.InputJsonValue })
}
