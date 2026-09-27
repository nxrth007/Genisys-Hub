import { getSecretByName } from './vault-service'

/**
 * Whop — where Genisys clients pay for the $297/mo package.
 *
 * REST v1: https://api.whop.com/api/v1, bearer auth, cursor pagination
 * via `page_info.end_cursor` + `has_next_page`.
 *
 * The key lives in the Vault rather than an env var so it can be rotated
 * from /vault without a redeploy, matching how the GHL tokens work. It is
 * read-only usage: this integration never creates or refunds anything.
 */

const BASE = 'https://api.whop.com/api/v1'

/** Vault entry names. Both optional-ish — see whopConfigured(). */
const KEY_ENTRY = 'Whop API Key'
const COMPANY_ENTRY = 'Whop Company ID'

export type WhopOrder = {
  id: string
  status: string
  /** Whop's finer-grained status, when it sends one. */
  substatus: string | null
  createdAt: string | null
  paidAt: string | null
  /** Charged amount in the order's own currency. */
  total: number | null
  /** Normalised to USD by Whop — the one safe field to sum across currencies. */
  usdTotal: number | null
  /** What actually lands after Whop's cut. */
  afterFees: number | null
  refunded: number | null
  currency: string | null
  /** subscription_create / subscription_cycle / one_time / … */
  billingReason: string | null
  customerName: string | null
  customerEmail: string | null
  customerUsername: string | null
  productTitle: string | null
  planId: string | null
  membershipStatus: string | null
  cardBrand: string | null
  cardLast4: string | null
}

async function readKey(): Promise<string> {
  const key = await getSecretByName(KEY_ENTRY)
  const trimmed = key.trim()
  if (!trimmed) throw new Error(`Vault entry "${KEY_ENTRY}" is empty.`)
  return trimmed
}

/** Optional — Whop infers the company from the key when this is absent. */
async function readCompanyId(): Promise<string | null> {
  try {
    const v = (await getSecretByName(COMPANY_ENTRY)).trim()
    return v || null
  } catch {
    return null
  }
}

/**
 * The account behind the key: `GET /accounts/me`.
 *
 * Doubles as a validity check. If this succeeds the key is real and
 * reachable, which separates "bad key" from "key can't see payments" —
 * two problems Whop reports with identical wording.
 */
export async function getWhopAccount(): Promise<{
  id: string | null
  businessName: string | null
  email: string | null
}> {
  const key = await readKey()
  const res = await fetch(`${BASE}/accounts/me`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `Whop returned ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`,
    )
  }
  const d = (await res.json()) as Raw
  // Some Whop endpoints wrap the object in `data`.
  const acct = (d.data ?? d) as Raw
  return {
    id: str(acct.id),
    businessName: str(acct.business_name),
    email: str(acct.email),
  }
}

/**
 * Company id, from the Vault if set, otherwise discovered once and kept
 * for the life of the process.
 *
 * Whop rejects /payments when it can't tell which company is being
 * asked about, and making Alex go and find a biz_ id by hand is a step
 * we can simply do for him.
 */
let discoveredCompanyId: string | null = null

async function resolveCompanyId(): Promise<string | null> {
  const configured = await readCompanyId()
  if (configured) return configured
  if (discoveredCompanyId) return discoveredCompanyId
  try {
    const acct = await getWhopAccount()
    discoveredCompanyId = acct.id
    return discoveredCompanyId
  } catch {
    // Discovery is best-effort — the caller still tries without it.
    return null
  }
}

/** Is Whop set up at all? Lets the UI show setup steps instead of an error. */
export async function whopConfigured(): Promise<boolean> {
  try {
    await readKey()
    return true
  } catch {
    return false
  }
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null

type Raw = Record<string, unknown>

function shape(p: Raw): WhopOrder {
  const user = (p.user ?? {}) as Raw
  const product = (p.product ?? {}) as Raw
  const plan = (p.plan ?? {}) as Raw
  const membership = (p.membership ?? {}) as Raw
  const method = (p.payment_method ?? {}) as Raw
  const card = (method.card ?? {}) as Raw

  return {
    id: String(p.id ?? ''),
    status: str(p.status) ?? 'unknown',
    substatus: str(p.substatus),
    createdAt: str(p.created_at),
    paidAt: str(p.paid_at),
    total: num(p.total),
    usdTotal: num(p.usd_total),
    afterFees: num(p.amount_after_fees),
    refunded: num(p.refunded_amount),
    currency: str(p.currency),
    billingReason: str(p.billing_reason),
    customerName: str(user.name),
    customerEmail: str(user.email),
    customerUsername: str(user.username),
    productTitle: str(product.title),
    planId: str(plan.id),
    membershipStatus: str(membership.status),
    // Whop reports the card both at the top level and on payment_method,
    // and which one is populated varies by payment type.
    cardBrand: str(p.card_brand) ?? str(card.brand),
    cardLast4: str(p.card_last4) ?? str(card.last4),
  }
}

/**
 * Try several request shapes and report which Whop accepts.
 *
 * Whop answers a rejected /payments call with a 400 whose message —
 * "You are not authorized - ensure that you have access to this
 * resource" — reads the same whether the key lacks scopes, the company
 * can't be inferred, or a parameter is malformed. Those need different
 * fixes, so this isolates the variable instead of guessing at it.
 *
 * Never returns the key. Whop's own response body is passed through
 * because its wording is the useful part.
 */
export async function probeWhop(): Promise<{
  companyIdConfigured: boolean
  attempts: Array<{
    label: string
    url: string
    status: number
    ok: boolean
    body: string
  }>
}> {
  const key = await readKey()
  const companyId = await readCompanyId()

  const attempts: Array<{
    label: string
    url: string
    status: number
    ok: boolean
    body: string
  }> = []

  // Does the key work for anything at all?
  const meUrl = `${BASE}/accounts/me`
  try {
    const res = await fetch(meUrl, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    })
    const body = await res.text().catch(() => '')
    attempts.push({
      label: 'identify key (/accounts/me)',
      url: meUrl,
      status: res.status,
      ok: res.ok,
      body: body.slice(0, 400),
    })
  } catch (err) {
    attempts.push({
      label: 'identify key (/accounts/me)',
      url: meUrl,
      status: 0,
      ok: false,
      body: err instanceof Error ? err.message : 'request failed',
    })
  }

  const variants: Array<{ label: string; qs: URLSearchParams }> = [
    { label: 'bare (no filters)', qs: new URLSearchParams({ first: '1' }) },
    {
      label: 'statuses[]=paid',
      qs: new URLSearchParams({ first: '1', 'statuses[]': 'paid' }),
    },
    {
      label: 'statuses=paid',
      qs: new URLSearchParams({ first: '1', statuses: 'paid' }),
    },
  ]
  if (companyId) {
    variants.push({
      label: 'company_id only',
      qs: new URLSearchParams({ first: '1', company_id: companyId }),
    })
  }

  for (const v of variants) {
    const url = `${BASE}/payments?${v.qs.toString()}`
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      })
      const body = await res.text().catch(() => '')
      attempts.push({
        label: v.label,
        url,
        status: res.status,
        ok: res.ok,
        body: body.slice(0, 400),
      })
    } catch (err) {
      attempts.push({
        label: v.label,
        url,
        status: 0,
        ok: false,
        body: err instanceof Error ? err.message : 'request failed',
      })
    }
  }

  return { companyIdConfigured: companyId !== null, attempts }
}

/**
 * Payments, newest first, following cursors until `max` or the last page.
 *
 * `statuses` defaults to paid — "confirmed orders" in Whop's vocabulary.
 * Passing an empty array returns everything, which is what a
 * failed/pending view would want.
 */
export async function listWhopOrders(opts: {
  max?: number
  statuses?: string[]
  createdAfter?: Date
} = {}): Promise<{ orders: WhopOrder[]; fetched: number; truncated: boolean }> {
  const key = await readKey()
  const companyId = await resolveCompanyId()

  const max = Math.min(1000, Math.max(1, opts.max ?? 200))
  const statuses = opts.statuses ?? ['paid']

  const orders: WhopOrder[] = []
  let after: string | null = null
  let pages = 0

  // Hard page ceiling as well as a record cap: a pagination bug that
  // never sets has_next_page=false would otherwise spin forever.
  while (orders.length < max && pages < 20) {
    const qs = new URLSearchParams({
      first: String(Math.min(50, max - orders.length)),
      order: 'created_at',
      direction: 'desc',
    })
    if (after) qs.set('after', after)
    if (companyId) qs.set('company_id', companyId)
    for (const s of statuses) qs.append('statuses[]', s)
    if (opts.createdAfter) {
      qs.set('created_after', opts.createdAfter.toISOString())
    }

    const res = await fetch(`${BASE}/payments?${qs.toString()}`, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(
        `Whop returned ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`,
      )
    }

    const payload = (await res.json()) as {
      data?: Raw[]
      page_info?: { end_cursor?: string | null; has_next_page?: boolean }
    }

    const batch = payload.data ?? []
    orders.push(...batch.map(shape))
    pages++

    const info = payload.page_info
    if (!info?.has_next_page || !info.end_cursor) break
    after = info.end_cursor
  }

  return {
    orders: orders.slice(0, max),
    fetched: orders.length,
    truncated: orders.length >= max,
  }
}

// ---------------------------------------------------------------------------
// The rest of the Whop surface, for the Hub's Payments → Whop tab.
// ---------------------------------------------------------------------------

/*
 * Whop serves two response shapes from the same URL, picked per request by
 * the `Api-Version-Date` header; with no header, the API key's own stored
 * version decides (docs.whop.com/developer/api/versioning). listWhopOrders
 * above deliberately sends no header: it is the path the CRM has proven
 * against the real key, and it must not move under it.
 *
 * Everything below pins a version, so its shape is known:
 *  - LEGACY ('2025-01-01') where the old shape carries what a person reads —
 *    memberships with the buyer's name, email and product; refunds and
 *    disputes with plain decimal amounts.
 *  - CURRENT ('2026-09-25') for what only exists, or only makes sense, in
 *    the new shape — the account and its balances, plans, promo codes,
 *    payouts and stats.
 * The parsers still accept either shape, so a pin Whop stops honouring
 * degrades to empty fields rather than a crash.
 */
const LEGACY_VERSION = '2025-01-01'
const CURRENT_VERSION = '2026-09-25'

/** A Whop request that failed, with the HTTP status so callers can tell a missing permission from a fault. */
export class WhopError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
  /** 401/403: the key lacks a permission for this resource. */
  get isPermission(): boolean {
    return this.status === 401 || this.status === 403
  }
}

/** Whop's own error text if the body carries one — its wording names the missing scope. */
function whopMessage(body: string): string | null {
  try {
    const d = JSON.parse(body) as { error?: { message?: string } | string; message?: string }
    if (typeof d.error === 'string') return d.error
    return d.error?.message ?? d.message ?? null
  } catch {
    return body.trim() ? body.slice(0, 300) : null
  }
}

async function whopGet(
  path: string,
  version: string,
  params: Record<string, string | undefined> = {},
): Promise<Raw> {
  const key = await readKey()
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') qs.set(k, v)
  }
  const query = qs.toString()
  const res = await fetch(`${BASE}${path}${query ? `?${query}` : ''}`, {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      'Api-Version-Date': version,
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new WhopError(whopMessage(body) ?? `Whop returned ${res.status}.`, res.status)
  }
  return (await res.json()) as Raw
}

/** Follow Whop's cursor pages until `max` rows or the last page. */
async function whopList(
  path: string,
  version: string,
  params: Record<string, string | undefined>,
  max: number,
  pageSize = 50,
): Promise<{ rows: Raw[]; truncated: boolean }> {
  const rows: Raw[] = []
  let after: string | undefined
  // A page ceiling as well as a row cap: a cursor that never ends must not spin.
  for (let page = 0; rows.length < max && page < 20; page++) {
    const d = await whopGet(path, version, {
      ...params,
      first: String(Math.min(pageSize, max - rows.length)),
      after,
    })
    rows.push(...(Array.isArray(d.data) ? (d.data as Raw[]) : []))
    const info = d.page_info as { end_cursor?: string | null; has_next_page?: boolean } | undefined
    if (!info?.has_next_page || !info.end_cursor) break
    after = info.end_cursor
  }
  return { rows: rows.slice(0, max), truncated: rows.length >= max }
}

/** An amount in major units from any of Whop's encodings: 10.5, "10.50", or {amount: "10.50"}. */
function amt(v: unknown): number | null {
  if (v && typeof v === 'object' && 'amount' in v) return num((v as Raw).amount)
  return num(v)
}

const obj = (v: unknown): Raw => (v && typeof v === 'object' ? (v as Raw) : {})

/** The account's biz_ id — Vault "Whop Company ID", or discovered from the key. */
export async function getWhopCompanyId(): Promise<string | null> {
  return resolveCompanyId()
}

export type WhopAccountView = {
  id: string | null
  title: string | null
  status: string | null
  /** Whole balance in USD, when Whop reports it. */
  totalUsd: number | null
  /** Lifetime sales in USD (needs stats:read on the key). */
  lifetimeUsd: number | null
  balances: Array<{
    symbol: string
    available: number | null
    pending: number | null
    /** Moving between the account's own destinations (sweeps, card top-ups) — split out of pending since 2026-08-13. */
    inTransit: number | null
    reserve: number | null
    valueUsd: number | null
  }>
}

/** GET /accounts/me — identity and balances (company:balance:read). */
export async function getWhopAccountView(): Promise<WhopAccountView> {
  const d = await whopGet('/accounts/me', CURRENT_VERSION)
  const a = obj(d.data ?? d)
  const balances = Array.isArray(a.balances) ? (a.balances as Raw[]) : []
  return {
    id: str(a.id),
    title: str(a.title) ?? str(a.business_name),
    status: str(a.status),
    totalUsd: amt(a.total_usd),
    lifetimeUsd: amt(a.total_earned_usd),
    balances: balances.map((b) => {
      const br = obj(b.breakdown)
      return {
        symbol: str(b.symbol) ?? '—',
        available: amt(br.available ?? b.balance),
        pending: amt(br.pending),
        inTransit: amt(br.in_transit),
        reserve: amt(br.reserve),
        valueUsd: amt(b.value_usd),
      }
    }),
  }
}

export type WhopMembership = {
  id: string
  status: string
  customerName: string | null
  customerEmail: string | null
  customerUsername: string | null
  productTitle: string | null
  /** Whop's formatted recurring price, e.g. "$297.00 / month". */
  renewalPrice: string | null
  joinedAt: string | null
  /** When the current period renews — or ends, if it is set to cancel. */
  periodEndsAt: string | null
  cancelAtPeriodEnd: boolean
  canceledAt: string | null
  cancellationReason: string | null
}

/** GET /memberships, legacy shape — the one that names the buyer and the product. */
export async function listWhopMemberships(
  companyId: string,
  max = 200,
): Promise<{ memberships: WhopMembership[]; truncated: boolean }> {
  const { rows, truncated } = await whopList(
    '/memberships',
    LEGACY_VERSION,
    { account_id: companyId, order: 'created_at', direction: 'desc' },
    max,
  )
  return {
    memberships: rows.map((m) => {
      const user = obj(m.user)
      return {
        id: String(m.id ?? ''),
        status: str(m.status) ?? 'unknown',
        customerName: str(user.name),
        customerEmail: str(user.email),
        customerUsername: str(user.username),
        productTitle: str(obj(m.product).title),
        renewalPrice: str(m.formatted_renewal_price),
        joinedAt: str(m.joined_at) ?? str(m.created_at),
        periodEndsAt: str(m.renewal_period_end) ?? str(m.current_period_end),
        cancelAtPeriodEnd: m.cancel_at_period_end === true,
        canceledAt: str(m.canceled_at),
        cancellationReason: str(m.cancellation_reason),
      }
    }),
    truncated,
  }
}

export type WhopPlan = {
  id: string
  title: string | null
  productTitle: string | null
  /** renewal (subscription) or one_time. */
  planType: string | null
  billingPeriodDays: number | null
  trialDays: number | null
  currency: string | null
  /** The recurring charge. On renewal plans initial_price is an extra first-charge add-on, not the price. */
  renewalPrice: number | null
  initialPrice: number | null
  formattedPrice: string | null
  members: number | null
  visibility: string | null
  purchaseUrl: string | null
}

/** GET /plans (current shape). */
export async function listWhopPlans(companyId: string): Promise<WhopPlan[]> {
  const { rows } = await whopList('/plans', CURRENT_VERSION, { account_id: companyId }, 200, 100)
  return rows.map((p) => ({
    id: String(p.id ?? ''),
    title: str(p.title),
    productTitle: str(obj(p.product).title),
    planType: str(p.plan_type),
    billingPeriodDays: num(p.billing_period),
    trialDays: num(p.trial_period_days),
    currency: str(p.currency),
    renewalPrice: amt(p.renewal_price),
    initialPrice: amt(p.initial_price),
    formattedPrice: str(p.formatted_price),
    members: num(p.member_count),
    visibility: str(p.visibility),
    purchaseUrl: str(p.purchase_url),
  }))
}

export type WhopPromoCode = {
  id: string
  code: string
  /** percentage | flat_amount */
  type: string | null
  /** Human-readable discount, derived from type + amount_off. */
  discount: string | null
  status: string | null
  uses: number | null
  stock: number | null
  unlimitedStock: boolean
  expiresAt: string | null
  productTitle: string | null
}

/** GET /promo_codes (current shape: a percentage amount_off is a fraction, 0.25 = 25%). */
export async function listWhopPromoCodes(companyId: string): Promise<WhopPromoCode[]> {
  const { rows } = await whopList('/promo_codes', CURRENT_VERSION, { account_id: companyId }, 200, 100)
  return rows.map((c) => {
    const type = str(c.promo_type)
    const off = num(c.amount_off)
    const currency = (str(c.currency) ?? 'usd').toUpperCase()
    let discount: string | null = null
    if (off !== null && type === 'percentage') {
      // Current shape reports 0.25 for 25%; a value above 1 is the older whole-number form.
      discount = `${Math.round((off <= 1 ? off * 100 : off) * 100) / 100}% off`
    } else if (off !== null) {
      discount = `${off.toFixed(2)} ${currency} off`
    }
    return {
      id: String(c.id ?? ''),
      code: str(c.code) ?? '—',
      type,
      discount,
      status: str(c.status),
      uses: num(c.uses),
      stock: num(c.stock),
      unlimitedStock: c.unlimited_stock === true,
      expiresAt: str(c.expires_at),
      productTitle: str(obj(c.product).title),
    }
  })
}

export type WhopRefund = {
  id: string
  amount: number | null
  currency: string | null
  status: string | null
  paymentId: string | null
  createdAt: string | null
}

/** GET /refunds, legacy shape (amount is a plain decimal, 10.43 = $10.43). */
export async function listWhopRefunds(companyId: string): Promise<WhopRefund[]> {
  const { rows } = await whopList('/refunds', LEGACY_VERSION, { account_id: companyId }, 100)
  return rows.map((r) => ({
    id: String(r.id ?? ''),
    amount: amt(r.amount),
    currency: str(r.currency),
    status: str(r.status),
    paymentId: str(obj(r.payment).id) ?? str(r.payment_id),
    createdAt: str(r.created_at),
  }))
}

export type WhopDispute = {
  id: string
  amount: number | null
  currency: string | null
  status: string | null
  reason: string | null
  needsResponseBy: string | null
  productTitle: string | null
  createdAt: string | null
}

/** GET /disputes, legacy shape (account_id is required there). */
export async function listWhopDisputes(companyId: string): Promise<WhopDispute[]> {
  const { rows } = await whopList('/disputes', LEGACY_VERSION, { account_id: companyId }, 100)
  return rows.map((d) => ({
    id: String(d.id ?? ''),
    amount: amt(d.amount),
    currency: str(d.currency),
    status: str(d.status),
    reason: str(d.reason),
    needsResponseBy: str(d.needs_response_by),
    productTitle: str(obj(d.product).title),
    createdAt: str(d.created_at),
  }))
}

export type WhopPayout = {
  id: string
  status: string | null
  amount: number | null
  fee: number | null
  net: number | null
  currency: string | null
  speed: string | null
  destination: string | null
  createdAt: string | null
  estimatedArrival: string | null
  failure: string | null
}

/** GET /payouts (current shape: amounts are decimal strings in whole units). */
export async function listWhopPayouts(companyId: string): Promise<WhopPayout[]> {
  const { rows } = await whopList('/payouts', CURRENT_VERSION, { account_id: companyId }, 100, 100)
  return rows.map((p) => ({
    id: String(p.id ?? ''),
    status: str(p.status),
    amount: amt(p.amount),
    fee: amt(p.fee_amount),
    net: amt(p.net_amount),
    currency: str(p.currency),
    speed: str(p.speed),
    destination: str(obj(p.payout_method).nickname),
    createdAt: str(p.created_at),
    estimatedArrival: str(p.estimated_arrival),
    failure: str(obj(p.failure).message),
  }))
}

/**
 * GET /stats/{metric} over the last `days` days (stats:read). Returns the
 * newest point and Whop's own window total — the docs say to use totals
 * rather than summing points.
 */
export async function getWhopStat(
  metric: string,
  companyId: string,
  days = 30,
): Promise<{ latest: number | null; total: number | null }> {
  const to = new Date()
  const from = new Date(to.getTime() - days * 86400_000)
  const d = await whopGet(`/stats/${encodeURIComponent(metric)}`, CURRENT_VERSION, {
    account_id: companyId,
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    interval: 'day',
  })
  const data = obj(d.data)
  const points = Array.isArray(data.points) ? (data.points as Raw[]) : []
  const totals = Array.isArray(data.totals) ? (data.totals as Raw[]) : []
  return {
    latest: points.length > 0 ? num(points[points.length - 1].value) : null,
    total: totals.length > 0 ? num(totals[0].value) : null,
  }
}
