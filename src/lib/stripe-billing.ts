/**
 * Stripe for the Clients page's subscriptions and the Payments page: which Vault
 * key, the calls to Stripe, what is kept in memory between requests, and the
 * join with the Hub's clients. The rules are in stripe-billing-plan.ts.
 *
 * Read-only on purpose: every call here is a GET. The Hub shows subscriptions,
 * payments and renewals; charging, refunding, cancelling and editing stay in
 * the Stripe Dashboard (tests/stripe-billing.test.mjs keeps it that way).
 */
import { prisma } from '@/lib/prisma'
import { firstSecret, STRIPE_KEY_ENTRIES } from './stripe-onboarding'
import { accountMarker, SIGNUP_ACCOUNT_MARKER } from './stripe-onboarding-plan'
import {
  describeKey,
  matchClients,
  readCustomer,
  readDenial,
  readSubscription,
  stateOf,
  summarize,
  type BillingCustomer,
  type BillingState,
  type BillingSubscription,
  type ClientBilling,
  type ClientForBilling,
  type StripeDenied,
  type StripeKeyKind,
  type UnmatchedCustomer,
} from './stripe-billing-plan'

/**
 * The Vault entries the Payments page and the Clients page's subscriptions read,
 * first found wins: a key made for the dashboard (read-only, with Balance,
 * Charges, Payouts, Invoices and Disputes read), else the sign-up gate's own
 * restricted key (Customers, Subscriptions and Checkout Sessions read — enough
 * for the subscriptions, not for balances or payouts). Both are the signup
 * site's Stripe account; the self-check on the Clients page says if one isn't.
 */
export const STRIPE_PAYMENTS_KEY_ENTRY = 'Stripe Official Payments Key'
export const STRIPE_PAYMENTS_KEY_ENTRIES = [STRIPE_PAYMENTS_KEY_ENTRY, ...STRIPE_KEY_ENTRIES]
/** The previous Stripe account's key ("Lead Genisys LLC"). Nothing reads it any more. */
export const LEGACY_STRIPE_KEY_ENTRY = 'Stripe API Key'
/** What to tick when making the dashboard key in Stripe → Developers → API keys → Create restricted key. */
export const PAYMENTS_KEY_PERMISSIONS = [
  'Balance: Read',
  'Balance transaction sources: Read',
  'Charges: Read',
  'Customers: Read',
  'Disputes: Read',
  'Invoices: Read',
  'Payouts: Read',
  'Subscriptions: Read',
  'Products: Read',
  'Checkout Sessions: Read',
]

export type PaymentsKey = { name: string; value: string; kind: StripeKeyKind; mode: 'live' | 'test' | null; readOnly: boolean }

/** The key the Payments page and the subscriptions view use, or null when the Vault has neither entry. */
export async function paymentsStripeKey(): Promise<PaymentsKey | null> {
  const s = await firstSecret(STRIPE_PAYMENTS_KEY_ENTRIES)
  return s ? { ...s, ...describeKey(s.value) } : null
}

const STRIPE = 'https://api.stripe.com/v1'
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

function stripeErrorMessage(data: unknown, status: number): string {
  const err = isObj(data) && isObj(data.error) ? data.error : null
  const message = err && typeof err.message === 'string' ? err.message.slice(0, 300) : ''
  return message ? `Stripe answered ${status}: ${message}` : `Stripe answered ${status || 'nothing'}`
}

export type StripeAnswer = { ok: boolean; status: number; data: unknown; denied: StripeDenied | null; error: string | null }

/** One GET to Stripe. Never throws: a network failure is an answer with status 0. */
export async function stripeRead(key: string, path: string): Promise<StripeAnswer> {
  try {
    const res = await fetch(`${STRIPE}${path}`, { headers: { Authorization: `Bearer ${key}` }, cache: 'no-store', signal: AbortSignal.timeout(15_000) })
    const data: unknown = await res.json().catch(() => ({}))
    const denied = res.ok ? null : readDenial({ path, status: res.status, data })
    return { ok: res.ok, status: res.status, data, denied, error: res.ok ? null : stripeErrorMessage(data, res.status) }
  } catch (err) {
    return { ok: false, status: 0, data: null, denied: null, error: `Stripe couldn't be reached: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** The objects of a Stripe list answer. */
export function listItems(answer: StripeAnswer): Obj[] {
  return answer.ok && isObj(answer.data) && Array.isArray(answer.data.data) ? answer.data.data.filter(isObj) : []
}

export type StripeListResult = { items: Obj[]; denied: StripeDenied | null; error: string | null; truncated: boolean }

/** Every page of a Stripe list (has_more / starting_after), up to `max` objects. */
export async function stripeList(key: string, path: string, max = 1000): Promise<StripeListResult> {
  const items: Obj[] = []
  let after: string | null = null
  for (;;) {
    const sep = path.includes('?') ? '&' : '?'
    const r = await stripeRead(key, `${path}${sep}limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ''}`)
    if (!r.ok) return { items, denied: r.denied, error: r.error, truncated: false }
    const page = listItems(r)
    items.push(...page)
    const last = page[page.length - 1]
    const hasMore = isObj(r.data) && r.data.has_more === true
    if (!hasMore || !last || typeof last.id !== 'string') return { items, denied: null, error: null, truncated: false }
    if (items.length >= max) return { items, denied: null, error: null, truncated: true }
    after = last.id
  }
}

// --- The snapshot: subscriptions and customers, kept two minutes --------------------

export type StripeAccountInfo = {
  /** acct_… when the key may read the account. */
  id: string | null
  name: string | null
  /** The 10-character account marker the key or any id carries. */
  marker: string | null
  /** This is the signup site's Stripe account (null: couldn't tell yet). */
  sameAsSignup: boolean | null
}

export type BillingSnapshot = {
  at: string
  key: { name: string; kind: StripeKeyKind; mode: 'live' | 'test' | null; readOnly: boolean } | null
  account: StripeAccountInfo
  subscriptions: BillingSubscription[]
  customers: BillingCustomer[]
  /** Reads this key wasn't allowed to make. */
  denied: StripeDenied[]
  /** Why there is no data at all (no key, Stripe down, subscriptions refused). */
  error: string | null
  /** The list was cut at the cap; the oldest objects are missing. */
  truncated: boolean
}

const SNAPSHOT_TTL_MS = 2 * 60_000
let cached: { at: number; snapshot: BillingSnapshot } | null = null
let inflight: Promise<BillingSnapshot> | null = null

/** Forget what was read: the webhook calls this when Stripe reports a change. */
export function invalidateBillingSnapshot(): void {
  cached = null
}

/**
 * Subscriptions and customers from Stripe, at most two minutes old (or fresh
 * when asked). Concurrent callers share one read, and a failed read is never
 * kept, so the next caller tries again.
 */
export async function billingSnapshot(o: { refresh?: boolean } = {}): Promise<BillingSnapshot> {
  if (!o.refresh && cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached.snapshot
  if (!inflight) {
    inflight = loadSnapshot()
      .then((s) => {
        if (!s.error) cached = { at: Date.now(), snapshot: s }
        return s
      })
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}

function accountInfo(keyValue: string | null, acct: Obj | null, ids: string[]): StripeAccountInfo {
  const id = acct ? str(acct.id) : null
  const marker = (keyValue ? accountMarker(keyValue) : null) ?? (id ? accountMarker(id) : null) ?? ids.map(accountMarker).find((m): m is string => !!m) ?? null
  const settings = acct && isObj(acct.settings) && isObj(acct.settings.dashboard) ? acct.settings.dashboard : null
  const profile = acct && isObj(acct.business_profile) ? acct.business_profile : null
  const name = (settings ? str(settings.display_name) : null) ?? (profile ? str(profile.name) : null) ?? (acct ? str(acct.email) : null)
  return { id, name, marker, sameAsSignup: marker ? marker === SIGNUP_ACCOUNT_MARKER : null }
}

async function loadSnapshot(): Promise<BillingSnapshot> {
  const at = new Date().toISOString()
  const key = await paymentsStripeKey()
  const keyInfo = key ? { name: key.name, kind: key.kind, mode: key.mode, readOnly: key.readOnly } : null
  if (!key) {
    return { at, key: null, account: accountInfo(null, null, []), subscriptions: [], customers: [], denied: [], error: `the Vault has no "${STRIPE_PAYMENTS_KEY_ENTRY}" and no "${STRIPE_KEY_ENTRIES[0]}"`, truncated: false }
  }
  const [account, products, expanded, customers] = await Promise.all([
    stripeRead(key.value, '/account'),
    stripeList(key.value, '/products?active=true', 200),
    stripeList(key.value, '/subscriptions?status=all&expand[]=data.customer'),
    stripeList(key.value, '/customers'),
  ])
  // A key without Customers read can't expand them; the subscriptions themselves may still be allowed.
  let subs = expanded
  if (subs.error && subs.denied?.permission !== 'rak_subscription_read') {
    const plain = await stripeList(key.value, '/subscriptions?status=all')
    if (!plain.error || plain.items.length) subs = plain
  }
  const productNames = new Map<string, string>()
  for (const p of products.items) {
    const id = str(p.id)
    const name = str(p.name)
    if (id && name) productNames.set(id, name)
  }
  const subscriptions = subs.items.map((s) => readSubscription(s, productNames)).filter((s): s is BillingSubscription => !!s)
  const customerList = customers.items.map(readCustomer).filter((c): c is BillingCustomer => !!c)
  const denied = [account.denied, products.denied, subs.denied, customers.denied].filter((d): d is StripeDenied => !!d)
  const acct = account.ok && isObj(account.data) ? account.data : null
  const info = accountInfo(key.value, acct, subscriptions.map((s) => s.id))
  if (subs.error && !subs.items.length) {
    return { at, key: keyInfo, account: info, subscriptions: [], customers: customerList, denied, error: `the "${key.name}" key couldn't list subscriptions (${subs.error})`, truncated: false }
  }
  return { at, key: keyInfo, account: info, subscriptions, customers: customerList, denied, error: null, truncated: subs.truncated || customers.truncated }
}

// --- The Clients page's view ------------------------------------------------------------

export type SubscriptionRow = BillingSubscription & {
  state: BillingState
  /** The client this subscription belongs to, or null when no client has the customer. */
  client: { id: string; name: string; archived: boolean; lifecycle: string } | null
}

export type ClientWithoutSubscription = { id: string; name: string; lifecycle: string; email: string | null; createdAt: string }

export type ClientSubscriptionsView = {
  asOf: string
  error: string | null
  key: BillingSnapshot['key']
  account: StripeAccountInfo
  denied: StripeDenied[]
  truncated: boolean
  summary: {
    total: number
    counts: Record<string, number>
    states: Record<Exclude<BillingState, 'none'>, number>
    upcoming30d: number
    problems: number
    unmatched: number
    clientsWithout: number
  }
  /** Every subscription, problems first, newest first. */
  rows: SubscriptionRow[]
  byClient: Record<string, ClientBilling>
  /** Stripe customers no client has. */
  unmatched: UnmatchedCustomer[]
  /** Roster clients (not archived, churned or denied) with no Stripe subscription at all. */
  clientsWithout: ClientWithoutSubscription[]
}

/** Every client with every email the Hub holds for them, for the match. */
export async function clientsForBilling(): Promise<Array<ClientForBilling & { createdAt: string; email: string | null }>> {
  const clients = await prisma.client.findMany({
    select: {
      id: true,
      name: true,
      lifecycle: true,
      archivedAt: true,
      createdAt: true,
      contactName: true,
      contactEmail: true,
      intakes: { orderBy: { receivedAt: 'desc' }, take: 1, select: { leadEmail: true, businessContact: true, fullName: true } },
      users: { select: { email: true } },
    },
  })
  return clients.map((c) => {
    const intake = c.intakes[0]
    return {
      id: c.id,
      name: c.name,
      lifecycle: c.lifecycle,
      archived: !!c.archivedAt,
      createdAt: c.createdAt.toISOString(),
      email: c.contactEmail ?? intake?.leadEmail ?? null,
      emails: [c.contactEmail, intake?.leadEmail, intake?.businessContact, ...c.users.map((u) => u.email)],
      people: [c.contactName, intake?.fullName],
    }
  })
}

const STATE_ORDER: Record<BillingState, number> = { problem: 0, ending: 1, active: 2, trialing: 3, canceled: 4, none: 5 }
const createdMs = (s: BillingSubscription) => (s.created ? new Date(s.created).getTime() : 0)

export async function clientSubscriptionsView(o: { refresh?: boolean } = {}): Promise<ClientSubscriptionsView> {
  const [snapshot, clients] = await Promise.all([billingSnapshot(o), clientsForBilling()])
  const match = matchClients(clients, snapshot.customers, snapshot.subscriptions)
  const summary = summarize(snapshot.subscriptions)
  const clientById = new Map(clients.map((c) => [c.id, c]))
  const rows: SubscriptionRow[] = []
  for (const b of Object.values(match.byClient)) {
    const c = clientById.get(b.clientId)
    for (const s of b.subscriptions) rows.push({ ...s, state: stateOf(s), client: c ? { id: c.id, name: c.name, archived: c.archived, lifecycle: c.lifecycle } : null })
  }
  for (const u of match.unmatched) for (const s of u.subscriptions) rows.push({ ...s, state: stateOf(s), client: null })
  rows.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || createdMs(b) - createdMs(a))
  const clientsWithout = clients
    .filter((c) => !c.archived && c.lifecycle !== 'churned' && c.lifecycle !== 'denied' && match.byClient[c.id]?.state === 'none')
    .map((c) => ({ id: c.id, name: c.name, lifecycle: c.lifecycle, email: c.email, createdAt: c.createdAt }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
  return {
    asOf: snapshot.at,
    error: snapshot.error,
    key: snapshot.key,
    account: snapshot.account,
    denied: snapshot.denied,
    truncated: snapshot.truncated,
    summary: {
      total: summary.total,
      counts: summary.counts,
      states: summary.states,
      upcoming30d: summary.upcoming.length,
      problems: summary.problems.length,
      unmatched: match.unmatched.length,
      clientsWithout: clientsWithout.length,
    },
    rows,
    byClient: match.byClient,
    unmatched: match.unmatched,
    clientsWithout,
  }
}
