import { getSecretByName } from '@/lib/vault-service'
import { HlInputError } from './http'

/**
 * Porkbun, the registrar Hell-level buys and holds client domains with (API
 * v3, porkbun.com/api/json/v3/documentation). The keys are Vault entries
 * "Porkbun API Key" and "Porkbun Secret API Key". Sandbox keys (pk1_sb_…)
 * run the same calls against fake credit, so the whole flow can be tried
 * without buying anything. Purchases come out of the Porkbun account's
 * prepaid credit, capped by the monthly spend limit set on
 * porkbun.com/account/api, and each domain needs "API access" turned on
 * there (one switch covers all of them).
 */

const BASE = 'https://api.porkbun.com/api/json/v3'
export const VAULT_KEY = 'Porkbun API Key'
export const VAULT_SECRET = 'Porkbun Secret API Key'

/** Porkbun's own refusal, shown to the person as is (an HlInputError, so routes answer 400 with it). */
export class PorkbunError extends HlInputError {
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string | null = null,
  ) {
    super(hint && !message.includes(hint) ? `${message} ${hint}` : message)
    this.name = 'PorkbunError'
  }
}

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
/** "11.08" (dollars, as Porkbun prices come) → 1108. */
export const dollarsToCents = (v: unknown): number | null => {
  const n = num(v)
  return n === null ? null : Math.round(n * 100)
}
const flag = (v: unknown): boolean | null => (v === 1 || v === '1' || v === 'yes' || v === true ? true : v === 0 || v === '0' || v === 'no' || v === false ? false : null)
/** Porkbun dates look like "2027-10-23 18:04:11". */
const date = (v: unknown): Date | null => {
  const s = str(v)
  if (!s) return null
  const d = new Date(/^\d{4}-\d\d-\d\d \d/.test(s) ? `${s.replace(' ', 'T')}Z` : s)
  return Number.isNaN(d.getTime()) ? null : d
}

let cached: { key: string; secret: string; at: number } | null = null

async function creds(): Promise<{ key: string; secret: string }> {
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached
  let key: string
  let secret: string
  try {
    ;[key, secret] = await Promise.all([getSecretByName(VAULT_KEY), getSecretByName(VAULT_SECRET)])
  } catch {
    throw new HlInputError(`Porkbun isn’t connected: add “${VAULT_KEY}” and “${VAULT_SECRET}” to the Vault (from porkbun.com/account/api).`)
  }
  cached = { key: key.trim(), secret: secret.trim(), at: Date.now() }
  return cached
}

/**
 * One API call. POSTs carry the keys in the body (Porkbun's main form);
 * GETs carry them as headers. Anything but status SUCCESS throws a
 * PorkbunError with Porkbun's code (INSUFFICIENT_FUNDS, COST_MISMATCH,
 * API_ACCESS_DISABLED…) and its message, which is written for people.
 */
async function call<T extends Rec = Rec>(path: string, body: Rec = {}, opts: { method?: 'GET' | 'POST'; idempotencyKey?: string } = {}): Promise<T> {
  const { key, secret } = await creds()
  const method = opts.method ?? 'POST'
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(method === 'GET' ? { 'X-API-Key': key, 'X-Secret-API-Key': secret } : { 'Content-Type': 'application/json' }),
          ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
        },
        body: method === 'POST' ? JSON.stringify({ ...body, apikey: key, secretapikey: secret }) : undefined,
        signal: AbortSignal.timeout(45_000),
      })
    } catch (err) {
      // Only reads are retried: a purchase that timed out may still have gone
      // through, and its idempotency key makes the person's retry safe instead.
      if (attempt < 2 && !opts.idempotencyKey) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
        continue
      }
      throw new PorkbunError('NETWORK', `Porkbun didn’t answer (${err instanceof Error ? err.message : String(err)}).`)
    }
    if (res.status === 429 && attempt < 3) {
      const after = Number(res.headers.get('retry-after'))
      await new Promise((r) => setTimeout(r, after > 0 ? Math.min(after, 30) * 1000 : 3000 * (attempt + 1)))
      continue
    }
    // An endpoint that only answers the other method: try that once.
    if (res.status === 405 && attempt === 0) return call<T>(path, body, { ...opts, method: method === 'GET' ? 'POST' : 'GET' })
    const text = await res.text()
    let data: Rec = {}
    try {
      data = text ? rec(JSON.parse(text)) : {}
    } catch {
      // not JSON
    }
    if (data.status === 'SUCCESS') return data as T
    const next = rec(data.next_action)
    throw new PorkbunError(str(data.code) ?? `HTTP_${res.status}`, str(data.message) ?? (text.slice(0, 200) || `Porkbun answered ${res.status}.`), str(next.hint))
  }
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export type RegistrarStatus = {
  connected: boolean
  sandbox: boolean
  account: string | null
  spendLimitCents: number | null
  monthlySpendCents: number | null
  error: string | null
}

export async function registrarStatus(): Promise<RegistrarStatus> {
  const off = (error: string): RegistrarStatus => ({ connected: false, sandbox: false, account: null, spendLimitCents: null, monthlySpendCents: null, error })
  let key: string
  try {
    key = (await creds()).key
  } catch (err) {
    return off(err instanceof Error ? err.message : String(err))
  }
  try {
    const ping = await call('/ping')
    if (ping.credentialsValid === false) return off('Porkbun says the keys in the Vault aren’t valid.')
    const out: RegistrarStatus = { connected: true, sandbox: key.startsWith('pk1_sb_') || ping.sandbox === true, account: str(ping.account), spendLimitCents: null, monthlySpendCents: null, error: null }
    try {
      const s = await call('/account/apiSettings', {}, { method: 'GET' })
      const settings = { ...s, ...rec(s.settings) }
      out.spendLimitCents = num(settings.spendLimit)
      out.monthlySpendCents = num(settings.monthlySpend)
    } catch {
      // optional
    }
    return out
  } catch (err) {
    return off(err instanceof Error ? err.message : String(err))
  }
}

// ---------------------------------------------------------------------------
// Availability, prices, registration
// ---------------------------------------------------------------------------

export type DomainCheck = {
  name: string
  available: boolean
  /** Per year, first year. */
  priceCents: number | null
  regularCents: number | null
  renewalCents: number | null
  transferCents: number | null
  premium: boolean
  promo: boolean
  inYourAccount: boolean
}

function toCheck(name: string, raw: unknown): DomainCheck {
  const r = rec(raw)
  const additional = rec(r.additional)
  return {
    name,
    available: r.avail === 'yes' || r.avail === true,
    priceCents: dollarsToCents(r.price),
    regularCents: dollarsToCents(r.regularPrice),
    renewalCents: dollarsToCents(rec(additional.renewal).price),
    transferCents: dollarsToCents(rec(additional.transfer).price),
    premium: r.premium === 'yes' || r.premium === true,
    promo: r.firstYearPromo === 'yes' || r.firstYearPromo === true,
    inYourAccount: r.inYourAccount === true || r.inYourAccount === 'yes',
  }
}

/** Up to 25 names in one call. */
export async function checkDomains(names: string[]): Promise<DomainCheck[]> {
  const list = [...new Set(names)].slice(0, 25)
  if (!list.length) return []
  if (list.length === 1) {
    const r = await call(`/domain/checkDomain/${list[0]}`)
    return [toCheck(list[0], r.response)]
  }
  const r = await call('/domain/checkDomain', { domains: list })
  const out = new Map<string, DomainCheck>()
  const found = r.domains
  if (Array.isArray(found)) {
    for (const d of found) {
      const name = str(rec(d).domain)
      if (name) out.set(name, toCheck(name, rec(d).response ?? d))
    }
  } else {
    for (const [name, d] of Object.entries(rec(found))) out.set(name, toCheck(name, rec(d).response ?? d))
  }
  return list.filter((n) => out.has(n)).map((n) => out.get(n)!)
}

export type Quote = { costCents: number; wouldSucceed: boolean; reason: string | null; balanceCents: number | null; shortfallCents: number | null }

function toQuote(r: Rec): Quote {
  const reasons = Array.isArray(r.reasons) ? r.reasons.map((x) => str(rec(x).message) ?? str(x)).filter(Boolean) : []
  return {
    costCents: num(r.cost) ?? 0,
    wouldSucceed: r.wouldSucceed !== false,
    reason: str(r.reason) ?? str(r.message) ?? (reasons.join(' ') || null),
    balanceCents: num(r.balance),
    shortfallCents: num(r.shortfall),
  }
}

/** What registering would cost, all in, without buying (a dry run with cost 0 returns the quote). */
export async function quoteRegistration(domain: string): Promise<Quote> {
  try {
    return toQuote(await call(`/domain/create/${domain}`, { cost: 0, agreeToTerms: 'yes', dryRun: true }))
  } catch (err) {
    // Short on credit still tells us the price.
    if (err instanceof PorkbunError && err.code === 'INSUFFICIENT_FUNDS') return { costCents: 0, wouldSucceed: false, reason: err.message, balanceCents: null, shortfallCents: null }
    throw err
  }
}

/** Buy it. `costCents` must be the quoted price exactly (Porkbun refuses a mismatch). */
export async function registerDomain(domain: string, costCents: number, idempotencyKey: string): Promise<{ orderId: string | null; costCents: number }> {
  const r = await call(`/domain/create/${domain}`, { cost: costCents, agreeToTerms: 'yes' }, { idempotencyKey })
  return { orderId: str(r.orderId), costCents: num(r.cost) ?? costCents }
}

// ---------------------------------------------------------------------------
// Domains in the account
// ---------------------------------------------------------------------------

export type RegistrarDomain = {
  name: string
  status: string | null
  createdAt: Date | null
  expiresAt: Date | null
  autoRenew: boolean | null
  apiAccess: boolean | null
  locked: boolean | null
  whoisPrivacy: boolean | null
}

function toDomain(raw: unknown): RegistrarDomain | null {
  const d = rec(raw)
  const name = str(d.domain)?.toLowerCase()
  if (!name) return null
  return {
    name,
    status: str(d.status),
    createdAt: date(d.createDate),
    expiresAt: date(d.expireDate),
    autoRenew: flag(d.autoRenew),
    apiAccess: flag(d.apiAccess),
    locked: flag(d.securityLock),
    whoisPrivacy: flag(d.whoisPrivacy),
  }
}

export async function listRegistrarDomains(): Promise<RegistrarDomain[]> {
  const out: RegistrarDomain[] = []
  for (let start = 0; start < 50_000; start += 1000) {
    const r = await call('/domain/listAll', { start: String(start) })
    const page = Array.isArray(r.domains) ? r.domains : []
    for (const d of page) {
      const x = toDomain(d)
      if (x) out.push(x)
    }
    if (page.length < 1000) break
  }
  return out
}

// ---------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------

export const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'ALIAS', 'MX', 'TXT', 'NS', 'SRV', 'CAA'] as const

export type DnsRecord = {
  id: string
  /** "" for the domain itself, else the part before it ("www", "_lovable"). */
  host: string
  type: string
  content: string
  ttl: number | null
  prio: number | null
  notes: string | null
}

/** retrieve gives the full name ("www.acme.com"); create and edit take only "www". */
export function hostOf(fqdn: string, domain: string): string {
  const n = fqdn.toLowerCase().replace(/\.$/, '')
  if (n === domain) return ''
  return n.endsWith(`.${domain}`) ? n.slice(0, -(domain.length + 1)) : n
}

export async function dnsRecords(domain: string): Promise<DnsRecord[]> {
  const r = await call(`/dns/retrieve/${domain}`)
  return (Array.isArray(r.records) ? r.records : []).map((x) => {
    const d = rec(x)
    return {
      id: String(d.id ?? ''),
      host: hostOf(String(d.name ?? domain), domain),
      type: String(d.type ?? '').toUpperCase(),
      content: String(d.content ?? ''),
      ttl: num(d.ttl),
      prio: num(d.prio),
      notes: str(d.notes),
    }
  })
}

export type RecordInput = { host: string; type: string; content: string; ttl?: number | null; prio?: number | null }

const recordBody = (r: RecordInput) => ({
  name: r.host,
  type: r.type,
  content: r.content,
  ...(r.ttl ? { ttl: String(r.ttl) } : {}),
  ...(r.prio !== undefined && r.prio !== null ? { prio: String(r.prio) } : {}),
})

export async function createRecord(domain: string, r: RecordInput): Promise<string | null> {
  const res = await call(`/dns/create/${domain}`, recordBody(r))
  return str(res.id)
}

export async function editRecord(domain: string, id: string, r: RecordInput): Promise<void> {
  await call(`/dns/edit/${domain}/${encodeURIComponent(id)}`, recordBody(r))
}

export async function deleteRecord(domain: string, id: string): Promise<void> {
  await call(`/dns/delete/${domain}/${encodeURIComponent(id)}`)
}

export async function getNameservers(domain: string): Promise<string[]> {
  const r = await call(`/domain/getNs/${domain}`)
  return (Array.isArray(r.ns) ? r.ns : []).map((n) => String(n).toLowerCase().replace(/\.$/, ''))
}

export async function setNameservers(domain: string, ns: string[]): Promise<void> {
  await call(`/domain/updateNs/${domain}`, { ns })
}

// ---------------------------------------------------------------------------
// Transfers in, without downtime: pay with holdForDnsSetup, build the zone
// here (prepareTransfer, then import what the current DNS answers), then
// release it to the registry. Nothing releases a held transfer but us.
// ---------------------------------------------------------------------------

export async function quoteTransfer(domain: string, authCode: string): Promise<Quote> {
  try {
    return toQuote(await call(`/domain/transfer/${domain}`, { authCode, cost: 0, holdForDnsSetup: true, dryRun: true }))
  } catch (err) {
    if (err instanceof PorkbunError && err.code === 'INSUFFICIENT_FUNDS') return { costCents: 0, wouldSucceed: false, reason: err.message, balanceCents: null, shortfallCents: null }
    throw err
  }
}

export async function payHeldTransfer(domain: string, authCode: string, costCents: number, idempotencyKey: string): Promise<{ orderId: string | null; transferId: string | null }> {
  const r = await call(`/domain/transfer/${domain}`, { authCode, cost: costCents, holdForDnsSetup: true }, { idempotencyKey })
  return { orderId: str(r.orderId), transferId: str(r.transferId) }
}

export async function prepareTransfer(domain: string): Promise<{ nameservers: string[]; recordCount: number | null }> {
  const r = await call(`/domain/prepareTransfer/${domain}`)
  return {
    nameservers: (Array.isArray(r.porkbunNameservers) ? r.porkbunNameservers : []).map((n) => String(n).toLowerCase().replace(/\.$/, '')),
    recordCount: num(r.recordCount),
  }
}

export type ScannedRecord = { host: string; type: string; content: string; ttl: number | null; prio: number | null }

/** What the domain's current nameservers answer for the usual names (not every record: Porkbun probes well-known names; 20 scans an hour). */
export async function scanDns(domain: string): Promise<ScannedRecord[]> {
  const r = await call(`/dns/scan/${domain}`, {}, { method: 'GET' })
  return (Array.isArray(r.records) ? r.records : [])
    .map((x) => {
      const d = rec(x)
      return { host: hostOf(String(d.name ?? domain), domain), type: String(d.type ?? '').toUpperCase(), content: String(d.content ?? ''), ttl: num(d.ttl), prio: num(d.prio) }
    })
    .filter((x) => x.type && x.type !== 'NS' && x.type !== 'SOA')
}

/** Copy records into the zone here. Without a list, Porkbun imports what a fresh scan finds. Already-present records are skipped. */
export async function importDns(domain: string, records?: ScannedRecord[]): Promise<{ created: number; skipped: number; failed: number }> {
  const r = await call(`/dns/import/${domain}`, records ? { records: records.map((x) => ({ name: x.host, type: x.type, content: x.content, ...(x.ttl ? { ttl: String(x.ttl) } : {}), ...(x.prio !== null ? { prio: String(x.prio) } : {}) })) } : {})
  return { created: num(r.created) ?? 0, skipped: num(r.skipped) ?? 0, failed: num(r.failed) ?? 0 }
}

export async function releaseTransfer(domain: string): Promise<void> {
  await call(`/domain/startTransfer/${domain}`)
}

export type TransferInfo = { status: string | null; description: string | null; at: Date | null }

export async function transferInfo(domain: string): Promise<TransferInfo> {
  const r = await call(`/domain/getTransfer/${domain}`, {}, { method: 'GET' })
  const t = rec(r.transfer)
  return { status: str(t.status)?.toUpperCase() ?? null, description: str(t.statusDescription), at: date(t.transferDate) }
}

export async function updateTransferAuthCode(domain: string, authCode: string): Promise<void> {
  await call(`/domain/updateTransferAuthCode/${domain}`, { authCode })
}

// ---------------------------------------------------------------------------
// Email forwarding and URL redirects
// ---------------------------------------------------------------------------

export type EmailForward = { address: string; forwardTo: string }

export async function emailForwards(domain: string): Promise<EmailForward[]> {
  const r = await call(`/email/getForwards/${domain}`)
  return (Array.isArray(r.forwards) ? r.forwards : []).map((x) => ({ address: String(rec(x).address ?? ''), forwardTo: String(rec(x).forwardTo ?? '') }))
}

/** Throws DNS_CHANGE_CONFIRMATION_REQUIRED when it would replace the domain's mail records; send again with confirm once the person agrees. */
export async function addEmailForward(domain: string, address: string, forwardTo: string, confirmDnsChanges = false): Promise<void> {
  await call(`/email/addForward/${domain}`, { address, forwardTo, ...(confirmDnsChanges ? { confirmDnsChanges: true } : {}) })
}

export async function deleteEmailForward(domain: string, address: string): Promise<void> {
  await call(`/email/deleteForward/${domain}`, { address })
}

export type UrlForward = { id: string; host: string; location: string; permanent: boolean; includePath: boolean; wildcard: boolean }

export async function urlForwards(domain: string): Promise<UrlForward[]> {
  const r = await call(`/domain/getUrlForwarding/${domain}`)
  return (Array.isArray(r.forwards) ? r.forwards : []).map((x) => {
    const d = rec(x)
    const type = String(d.redirectType ?? d.type ?? '')
    return { id: String(d.id ?? ''), host: String(d.subdomain ?? ''), location: String(d.location ?? ''), permanent: type === 'permanent' || type === '301', includePath: flag(d.includePath) ?? false, wildcard: flag(d.wildcard) ?? false }
  })
}

export async function addUrlForward(domain: string, f: Omit<UrlForward, 'id'>): Promise<void> {
  await call(`/domain/addUrlForward/${domain}`, {
    subdomain: f.host,
    location: f.location,
    type: f.permanent ? 'permanent' : 'temporary',
    includePath: f.includePath ? 'yes' : 'no',
    wildcard: f.wildcard ? 'yes' : 'no',
  })
}

export async function deleteUrlForward(domain: string, id: string): Promise<void> {
  await call(`/domain/deleteUrlForward/${domain}/${encodeURIComponent(id)}`)
}
