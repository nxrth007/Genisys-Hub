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

  const attempts = []
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
  const companyId = await readCompanyId()

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
