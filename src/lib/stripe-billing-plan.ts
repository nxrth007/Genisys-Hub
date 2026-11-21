/**
 * Stripe subscriptions as the Hub shows them: on the Clients page (each
 * client's subscription next to the client, every subscription in one list,
 * the Stripe customers that match no client) and on the Payments page (MRR,
 * renewals due, payment problems). This is the part with no Hub in it — the
 * tests load it and the client components import it, so it pulls in nothing
 * from Node. src/lib/stripe-billing.ts talks to Stripe and the database.
 *
 * Nothing here, or anywhere that uses it, writes to Stripe: the Hub looks at
 * subscriptions, it never charges, refunds, cancels or edits them.
 */

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const lower = (v: unknown): string | null => str(v)?.toLowerCase() ?? null
/** Stripe's epoch seconds as an ISO date. */
const iso = (secs: unknown): string | null => {
  const n = num(secs)
  return n ? new Date(n * 1000).toISOString() : null
}
/** A Stripe reference that may be an id or the expanded object. */
const idOf = (v: unknown): string | null => (typeof v === 'string' ? str(v) : isObj(v) ? str(v.id) : null)

// --- Money and plans --------------------------------------------------------

/** The plans sold at leadgenisys.com, so a price with no nickname still gets its name. */
export const GENISYS_PLANS: ReadonlyArray<{ name: string; cents: number; interval: string; count: number }> = [
  { name: 'Starter', cents: 9700, interval: 'month', count: 1 },
  { name: 'Growth', cents: 29700, interval: 'month', count: 1 },
  { name: 'Scale', cents: 79700, interval: 'month', count: 3 },
]

/** "$297", "$25.50", "CAD 10" from an amount in cents. */
export function money(cents: number, currency = 'usd'): string {
  const code = currency.toUpperCase()
  const prefix = code === 'USD' ? '$' : `${code} `
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}${prefix}${abs % 100 === 0 ? String(abs / 100) : (abs / 100).toFixed(2)}`
}

const SHORT_INTERVAL: Record<string, string> = { month: 'mo', year: 'yr', week: 'wk', day: 'day' }

/** "$297/mo", "$797/3 months", "$50" (no interval). */
export function priceLabel(o: { cents: number | null; currency: string; interval: string | null; count: number }): string | null {
  if (o.cents === null) return null
  const amount = money(o.cents, o.currency)
  if (!o.interval) return amount
  return `${amount}/${o.count === 1 ? (SHORT_INTERVAL[o.interval] ?? o.interval) : `${o.count} ${o.interval}s`}`
}

/** What a recurring amount is worth per month, for MRR. */
export function monthlyCents(cents: number, interval: string | null, count: number): number {
  const per = cents / (count || 1)
  switch (interval) {
    case 'year':
      return per / 12
    case 'week':
      return per * (52 / 12)
    case 'day':
      return per * (365 / 12)
    case 'month':
    default:
      return per
  }
}

/** The plan's name: Stripe's nickname or product name, else the Genisys plan that bills this much. */
export function planName(o: { nickname?: string | null; productName?: string | null; cents: number | null; interval: string | null; count: number }): string | null {
  if (o.nickname) return o.nickname
  if (o.productName) return o.productName
  if (o.cents === null) return null
  return GENISYS_PLANS.find((p) => p.cents === o.cents && p.interval === (o.interval ?? 'month') && p.count === o.count)?.name ?? null
}

/** "Dec 17" for a chip or a table cell. */
export function shortDate(isoDate: string | null | undefined): string | null {
  if (!isoDate) return null
  const d = new Date(isoDate)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })
}

// --- What Stripe sends, read ---------------------------------------------------

export type BillingSubscription = {
  id: string
  customerId: string | null
  /** The customer's email, lowercased, when the customer came expanded. */
  email: string | null
  name: string | null
  phone: string | null
  /** trialing | active | past_due | unpaid | canceled | incomplete | incomplete_expired | paused */
  status: string
  /** "Growth" when the price says (or bills like) a Genisys plan. */
  plan: string | null
  /** "$297/mo" */
  price: string | null
  /** What one billing period costs, every item and quantity in. */
  amountCents: number | null
  currency: string
  interval: string | null
  intervalCount: number
  /** amountCents per month, for MRR. */
  monthlyCents: number
  created: string | null
  trialEnd: string | null
  /** When the running period ends: the next charge, or the end if cancelAtPeriodEnd. */
  periodEnd: string | null
  cancelAtPeriodEnd: boolean
  canceledAt: string | null
  endedAt: string | null
  /** Collection paused by hand in Stripe (pause_collection). */
  collectionPaused: boolean
  latestInvoiceId: string | null
  livemode: boolean
}

export type BillingCustomer = {
  id: string
  email: string | null
  name: string | null
  phone: string | null
  created: string | null
  /** Stripe's flag: the latest invoice wasn't paid. */
  delinquent: boolean
  livemode: boolean
}

function subscriptionItems(sub: Obj): Obj[] {
  const items = isObj(sub.items) && Array.isArray(sub.items.data) ? sub.items.data : []
  return items.filter(isObj)
}

/** A Stripe Subscription (customer expanded or not) as the Hub keeps it; null for anything else. */
export function readSubscription(raw: unknown, productNames: ReadonlyMap<string, string> = new Map()): BillingSubscription | null {
  if (!isObj(raw) || str(raw.object) !== 'subscription' || !str(raw.id)) return null
  const items = subscriptionItems(raw)
  const first = items[0]
  const firstPrice = first && isObj(first.price) ? first.price : null
  const recurring = firstPrice && isObj(firstPrice.recurring) ? firstPrice.recurring : null
  const interval = recurring ? str(recurring.interval) : null
  const intervalCount = recurring ? (num(recurring.interval_count) ?? 1) : 1
  const currency = (firstPrice ? lower(firstPrice.currency) : null) ?? lower(raw.currency) ?? 'usd'
  let amountCents: number | null = null
  for (const item of items) {
    const price = isObj(item.price) ? item.price : null
    const unit = price ? num(price.unit_amount) : null
    if (unit === null) continue
    amountCents = (amountCents ?? 0) + unit * (num(item.quantity) ?? 1)
  }
  const productId = firstPrice ? idOf(firstPrice.product) : null
  const productName = (productId && productNames.get(productId)) || (firstPrice && isObj(firstPrice.product) ? str(firstPrice.product.name) : null)
  const customer = isObj(raw.customer) ? raw.customer : null
  const pause = isObj(raw.pause_collection) ? raw.pause_collection : null
  return {
    id: str(raw.id) as string,
    customerId: idOf(raw.customer),
    email: customer ? lower(customer.email) : null,
    name: customer ? str(customer.name) : null,
    phone: customer ? str(customer.phone) : null,
    status: str(raw.status) ?? 'unknown',
    plan: planName({ nickname: firstPrice ? str(firstPrice.nickname) : null, productName, cents: amountCents, interval, count: intervalCount }),
    price: priceLabel({ cents: amountCents, currency, interval, count: intervalCount }),
    amountCents,
    currency,
    interval,
    intervalCount,
    monthlyCents: amountCents === null ? 0 : Math.round(monthlyCents(amountCents, interval, intervalCount)),
    created: iso(raw.created),
    trialEnd: iso(raw.trial_end),
    // Newer Stripe API versions keep the period on the item, older ones on the subscription.
    periodEnd: iso(raw.current_period_end ?? first?.current_period_end),
    cancelAtPeriodEnd: raw.cancel_at_period_end === true,
    canceledAt: iso(raw.canceled_at),
    endedAt: iso(raw.ended_at),
    collectionPaused: !!pause && !!str(pause.behavior),
    latestInvoiceId: idOf(raw.latest_invoice),
    livemode: raw.livemode === true,
  }
}

/** A Stripe Customer as the Hub keeps it; null for anything else (a deleted customer stub, say). */
export function readCustomer(raw: unknown): BillingCustomer | null {
  if (!isObj(raw) || str(raw.object) !== 'customer' || !str(raw.id) || raw.deleted === true) return null
  return {
    id: str(raw.id) as string,
    email: lower(raw.email),
    name: str(raw.name),
    phone: str(raw.phone),
    created: iso(raw.created),
    delinquent: raw.delinquent === true,
    livemode: raw.livemode === true,
  }
}

// --- Where a client stands --------------------------------------------------------

/**
 * problem: Stripe couldn't collect (past_due, unpaid, incomplete) or the trial
 * ended with no card (paused). ending: still running, but set to cancel at the
 * period's end. canceled covers incomplete_expired too (it never started).
 */
export type BillingState = 'active' | 'trialing' | 'problem' | 'ending' | 'canceled' | 'none'

export const PROBLEM_STATUSES: ReadonlySet<string> = new Set(['past_due', 'unpaid', 'incomplete', 'paused'])
const LIVE_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing'])

export function stateOf(sub: BillingSubscription | null | undefined): BillingState {
  if (!sub) return 'none'
  if (PROBLEM_STATUSES.has(sub.status)) return 'problem'
  if (LIVE_STATUSES.has(sub.status)) {
    if (sub.cancelAtPeriodEnd || sub.collectionPaused) return 'ending'
    return sub.status === 'trialing' ? 'trialing' : 'active'
  }
  return 'canceled'
}

/** Problems first, then what's running, then what ended; newest first within each. */
const STATE_RANK: Record<BillingState, number> = { problem: 0, active: 1, ending: 2, trialing: 3, canceled: 4, none: 5 }

const createdMs = (s: BillingSubscription) => (s.created ? new Date(s.created).getTime() : 0)

/** The one subscription that says where a customer stands, out of all they ever had. */
export function decidingSubscription(subs: BillingSubscription[]): BillingSubscription | null {
  return (
    [...subs].sort((a, b) => STATE_RANK[stateOf(a)] - STATE_RANK[stateOf(b)] || createdMs(b) - createdMs(a))[0] ?? null
  )
}

// --- Clients ↔ Stripe customers --------------------------------------------------------

export type ClientForBilling = {
  id: string
  name: string
  /** Every email the Hub has for them: contact, onboarding form, their logins. */
  emails: Array<string | null | undefined>
  /** The people behind the business, for the name fallback. */
  people?: Array<string | null | undefined>
  archived: boolean
  lifecycle: string
}

export type ClientBilling = {
  clientId: string
  state: BillingState
  /** The subscription that decides the state (null: none at all). */
  subscription: BillingSubscription | null
  /** Every subscription of this client's Stripe customers, newest first. */
  subscriptions: BillingSubscription[]
  customers: BillingCustomer[]
  matchedBy: 'email' | 'name' | null
}

export type UnmatchedCustomer = {
  customer: BillingCustomer
  state: BillingState
  subscription: BillingSubscription | null
  subscriptions: BillingSubscription[]
  /** A client this might be (same words in the name), for a human to check. */
  suggestion: { clientId: string; name: string } | null
}

export type BillingMatch = {
  byClient: Record<string, ClientBilling>
  unmatched: UnmatchedCustomer[]
}

const normName = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(llc|inc|co|corp|ltd|the|and)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const cleanEmail = (v: string | null | undefined): string | null => {
  const e = (v ?? '').trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null
}

/** A client's names (the business, then the people behind it), normalised, each once. */
const namesOf = (cl: ClientForBilling): string[] => [...new Set([cl.name, ...(cl.people ?? [])].map((n) => (n ? normName(n) : '')).filter(Boolean))]

/**
 * Which client each Stripe customer is: by email first, the way the onboarding
 * form's check does (case and whitespace don't matter), then by the business or
 * person's name when exactly one client has it. Customers that match nobody are
 * listed so nobody is lost; a subscription whose customer isn't in the customer
 * list (the list was cut short, or the customer was deleted) still counts.
 */
export function matchClients(clients: ClientForBilling[], customers: BillingCustomer[], subscriptions: BillingSubscription[]): BillingMatch {
  // Every customer, including those only a subscription mentions.
  const customerById = new Map<string, BillingCustomer>()
  for (const c of customers) customerById.set(c.id, c)
  for (const s of subscriptions) {
    if (s.customerId && !customerById.has(s.customerId)) {
      customerById.set(s.customerId, { id: s.customerId, email: s.email, name: s.name, phone: s.phone, created: s.created, delinquent: false, livemode: s.livemode })
    }
  }
  const subsByCustomer = new Map<string, BillingSubscription[]>()
  for (const s of subscriptions) {
    if (!s.customerId) continue
    const list = subsByCustomer.get(s.customerId) ?? []
    list.push(s)
    subsByCustomer.set(s.customerId, list)
  }
  for (const list of subsByCustomer.values()) list.sort((a, b) => createdMs(b) - createdMs(a))

  const customersByEmail = new Map<string, BillingCustomer[]>()
  const customersByName = new Map<string, BillingCustomer[]>()
  for (const c of customerById.values()) {
    const email = cleanEmail(c.email)
    if (email) customersByEmail.set(email, [...(customersByEmail.get(email) ?? []), c])
    const n = c.name ? normName(c.name) : ''
    if (n) customersByName.set(n, [...(customersByName.get(n) ?? []), c])
  }
  // Which clients go by each name. A client counts once per name however often it's on file: the contact
  // name and the onboarding form's name are usually the same person, and counting both made the owner's
  // name look shared by two clients, so a sign-up under a personal email matched nobody (Nov 2026).
  const clientsByName = new Map<string, ClientForBilling[]>()
  for (const cl of clients) {
    for (const n of namesOf(cl)) clientsByName.set(n, [...(clientsByName.get(n) ?? []), cl])
  }

  const taken = new Set<string>()
  const byClient: Record<string, ClientBilling> = {}
  /** Give a client these customers (the ones nobody has yet); a second match adds to the first. */
  const claim = (cl: ClientForBilling, found: BillingCustomer[], matchedBy: 'email' | 'name') => {
    const fresh = found.filter((c) => !taken.has(c.id))
    if (!fresh.length) return
    for (const c of fresh) taken.add(c.id)
    const mine = [...(byClient[cl.id]?.customers ?? []), ...fresh]
    const subs = mine.flatMap((c) => subsByCustomer.get(c.id) ?? []).sort((a, b) => createdMs(b) - createdMs(a))
    const deciding = decidingSubscription(subs)
    byClient[cl.id] = { clientId: cl.id, state: stateOf(deciding), subscription: deciding, subscriptions: subs, customers: mine, matchedBy: byClient[cl.id]?.matchedBy ?? matchedBy }
  }
  // Emails first, for every client, so a name never steals a customer an email places elsewhere.
  for (const cl of clients) {
    const emails = [...new Set(cl.emails.map(cleanEmail).filter((e): e is string => !!e))]
    claim(cl, emails.flatMap((e) => customersByEmail.get(e) ?? []), 'email')
  }
  // Then names: a customer named after the business (or its owner) when that name points at this one client.
  // A client the emails already placed can gain a second customer this way (a sign-up under a personal email).
  for (const cl of clients) {
    const names = namesOf(cl)
    const found = names.flatMap((n) => customersByName.get(n) ?? [])
    if (found.length && names.every((n) => (clientsByName.get(n) ?? []).length === 1)) claim(cl, found, 'name')
  }
  for (const cl of clients) {
    if (!byClient[cl.id]) byClient[cl.id] = { clientId: cl.id, state: 'none', subscription: null, subscriptions: [], customers: [], matchedBy: null }
  }

  const unmatched: UnmatchedCustomer[] = []
  for (const c of customerById.values()) {
    if (taken.has(c.id)) continue
    const subs = subsByCustomer.get(c.id) ?? []
    const deciding = decidingSubscription(subs)
    unmatched.push({ customer: c, state: stateOf(deciding), subscription: deciding, subscriptions: subs, suggestion: suggestClient(c, clients) })
  }
  unmatched.sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || (b.customer.created ?? '').localeCompare(a.customer.created ?? ''))
  return { byClient, unmatched }
}

/** A client whose name shares its words with the customer's, when there is exactly one. */
function suggestClient(c: BillingCustomer, clients: ClientForBilling[]): { clientId: string; name: string } | null {
  const n = c.name ? normName(c.name) : ''
  if (n.length < 4) return null
  const hits = clients.filter((cl) => {
    const m = normName(cl.name)
    return m.length >= 4 && (m.includes(n) || n.includes(m))
  })
  return hits.length === 1 ? { clientId: hits[0].id, name: hits[0].name } : null
}

// --- The account's numbers ---------------------------------------------------------

export type UpcomingCharge = {
  subscription: BillingSubscription
  /** When Stripe will charge (ISO). */
  at: string
  kind: 'first charge' | 'renewal'
  amountCents: number | null
}

export type BillingSummary = {
  total: number
  /** By Stripe status: trialing, active, past_due, canceled, … */
  counts: Record<string, number>
  /** By the Hub's reading of each subscription. */
  states: Record<Exclude<BillingState, 'none'>, number>
  /** Active and past-due subscriptions per month, the way Stripe's own MRR counts. */
  mrrCents: number
  /** What the running trials turn into once they convert. */
  trialMonthlyCents: number
  /** Charges due within the window, soonest first. */
  upcoming: UpcomingCharge[]
  problems: BillingSubscription[]
  /** Still running, set to end at the period's close. */
  ending: BillingSubscription[]
  /** Ended within the window. */
  canceledRecently: BillingSubscription[]
}

export function summarize(subs: BillingSubscription[], now = Date.now(), windowDays = 30): BillingSummary {
  const windowMs = windowDays * 86_400_000
  const counts: Record<string, number> = {}
  const states: BillingSummary['states'] = { active: 0, trialing: 0, problem: 0, ending: 0, canceled: 0 }
  let mrrCents = 0
  let trialMonthlyCents = 0
  const upcoming: UpcomingCharge[] = []
  const problems: BillingSubscription[] = []
  const ending: BillingSubscription[] = []
  const canceledRecently: BillingSubscription[] = []
  for (const s of subs) {
    counts[s.status] = (counts[s.status] ?? 0) + 1
    const state = stateOf(s)
    states[state === 'none' ? 'canceled' : state] += 1
    if (s.status === 'active' || s.status === 'past_due') mrrCents += s.monthlyCents
    if (s.status === 'trialing') trialMonthlyCents += s.monthlyCents
    if (state === 'problem') problems.push(s)
    if (state === 'ending') ending.push(s)
    if (state === 'canceled') {
      const endedMs = s.endedAt ? new Date(s.endedAt).getTime() : s.canceledAt ? new Date(s.canceledAt).getTime() : 0
      if (endedMs && now - endedMs <= windowMs) canceledRecently.push(s)
    }
    if (state === 'active' || state === 'trialing') {
      const at = s.status === 'trialing' ? (s.trialEnd ?? s.periodEnd) : s.periodEnd
      const atMs = at ? new Date(at).getTime() : 0
      if (at && atMs >= now - 86_400_000 && atMs - now <= windowMs) {
        upcoming.push({ subscription: s, at, kind: s.status === 'trialing' ? 'first charge' : 'renewal', amountCents: s.amountCents })
      }
    }
  }
  upcoming.sort((a, b) => a.at.localeCompare(b.at))
  const byEnd = (a: BillingSubscription, b: BillingSubscription) => (a.periodEnd ?? '').localeCompare(b.periodEnd ?? '')
  ending.sort(byEnd)
  canceledRecently.sort((a, b) => (b.endedAt ?? b.canceledAt ?? '').localeCompare(a.endedAt ?? a.canceledAt ?? ''))
  return { total: subs.length, counts, states, mrrCents: Math.round(mrrCents), trialMonthlyCents: Math.round(trialMonthlyCents), upcoming, problems, ending, canceledRecently }
}

// --- Keys, permissions, links ----------------------------------------------------------

export type StripeKeyKind = 'restricted' | 'secret' | 'publishable' | 'unknown'

/** What kind of key the Vault holds. The Hub treats anything but a full secret key as read-only. */
export function describeKey(key: string): { kind: StripeKeyKind; mode: 'live' | 'test' | null; readOnly: boolean } {
  const m = /^(rk|sk|pk)_(live|test)_/.exec(key.trim())
  const kind: StripeKeyKind = m?.[1] === 'rk' ? 'restricted' : m?.[1] === 'sk' ? 'secret' : m?.[1] === 'pk' ? 'publishable' : 'unknown'
  return { kind, mode: m ? (m[2] as 'live' | 'test') : null, readOnly: kind !== 'secret' }
}

/** What the Payments page reads from Stripe, by the path's first segment, in the words of Stripe's restricted-key form. */
export const STRIPE_READS: Record<string, string> = {
  account: 'Account details',
  balance: 'Balance',
  balance_transactions: 'Balance transactions',
  charges: 'Charges (payments)',
  payouts: 'Payouts',
  disputes: 'Disputes',
  invoices: 'Invoices',
  subscriptions: 'Subscriptions',
  customers: 'Customers',
  products: 'Products (plan names)',
}

/** The permission names Stripe's error messages use, as the restricted-key form labels them. */
const PERMISSION_LABELS: Record<string, string> = {
  rak_balance_read: 'Balance: Read',
  rak_balance_transaction_source_read: 'Balance transaction sources: Read',
  rak_charge_read: 'Charges: Read',
  rak_customer_read: 'Customers: Read',
  rak_dispute_read: 'Disputes: Read',
  rak_invoice_read: 'Invoices: Read',
  rak_payout_read: 'Payouts: Read',
  rak_subscription_read: 'Subscriptions: Read',
  rak_product_read: 'Products: Read',
  rak_checkout_session_read: 'Checkout Sessions: Read',
  rak_payment_intent_read: 'PaymentIntents: Read',
}

export function permissionLabel(permission: string | null): string | null {
  if (!permission) return null
  return PERMISSION_LABELS[permission] ?? permission
}

export type StripeDenied = {
  /** "Charges (payments)" — what the Hub wanted. */
  what: string
  path: string
  /** Stripe's own name for the missing permission (rak_charge_read), when its message gave one. */
  permission: string | null
  message: string
}

/**
 * A restricted key that lacks a permission gets a 403 from Stripe whose message
 * names the permission ("Having the 'rak_charge_read' permission would allow this
 * request to continue"). Anything else that went wrong is not a denial.
 */
export function readDenial(o: { path: string; status: number; data: unknown }): StripeDenied | null {
  const err = isObj(o.data) && isObj(o.data.error) ? o.data.error : null
  const message = (err && str(err.message)) ?? ''
  const permission = /\b(rak_[a-z_]+)\b/.exec(message)?.[1] ?? null
  if (o.status !== 403 && !permission && !/permission/i.test(message)) return null
  const segment = o.path.replace(/^\//, '').split(/[/?]/)[0] ?? ''
  return { what: STRIPE_READS[segment] ?? segment, path: o.path, permission, message: message.slice(0, 300) }
}

/** A Stripe Dashboard link for an object, in the right account and mode. */
export function stripeLink(kind: 'customer' | 'subscription' | 'invoice' | 'payment' | 'payout' | 'dispute', id: string, o: { accountId?: string | null; livemode?: boolean } = {}): string {
  const paths: Record<typeof kind, string> = { customer: 'customers', subscription: 'subscriptions', invoice: 'invoices', payment: 'payments', payout: 'payouts', dispute: 'disputes' }
  const account = o.accountId ? `${o.accountId}/` : ''
  const mode = o.livemode === false ? 'test/' : ''
  return `https://dashboard.stripe.com/${account}${mode}${paths[kind]}/${encodeURIComponent(id)}`
}

// --- Words for the Clients page ------------------------------------------------------------

export type BillingTone = 'mint' | 'blue' | 'amber' | 'pink' | 'muted'

/** The chip on a client's row: a word, a tone, and the detail that matters next. */
export function billingLabel(b: { state: BillingState; subscription: BillingSubscription | null } | null | undefined): { text: string; detail: string | null; tone: BillingTone } {
  const s = b?.subscription ?? null
  switch (b?.state ?? 'none') {
    case 'active':
      return { text: s?.price ? `Active · ${s.price}` : 'Active', detail: s?.periodEnd ? `renews ${shortDate(s.periodEnd)}` : null, tone: 'mint' }
    case 'trialing':
      return { text: s?.price ? `Trial · ${s.price}` : 'Trial', detail: s?.trialEnd ? `first charge ${shortDate(s.trialEnd)}` : null, tone: 'blue' }
    case 'problem': {
      const word = s?.status === 'paused' ? 'No card' : s?.status === 'incomplete' ? 'Incomplete' : s?.status === 'unpaid' ? 'Unpaid' : 'Past due'
      return { text: s?.price ? `${word} · ${s.price}` : word, detail: s?.status === 'past_due' ? 'Stripe is retrying the card' : s?.status === 'paused' ? 'trial ended without a card' : null, tone: 'pink' }
    }
    case 'ending':
      return { text: s?.collectionPaused && !s.cancelAtPeriodEnd ? 'Collection paused' : 'Ending', detail: s?.periodEnd ? `ends ${shortDate(s.periodEnd)}` : null, tone: 'amber' }
    case 'canceled': {
      const when = s?.endedAt ?? s?.canceledAt ?? null
      return { text: s?.status === 'incomplete_expired' ? 'Never started' : 'Canceled', detail: when ? `ended ${shortDate(when)}` : null, tone: 'amber' }
    }
    default:
      return { text: 'Not in Stripe', detail: null, tone: 'muted' }
  }
}
