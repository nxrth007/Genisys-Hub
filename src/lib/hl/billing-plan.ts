/**
 * A client's Whop billing on Hell-level → Memberships (Alex, 2026-11-14: "add Whop billing but make
 * it read only"). Pure (tests load it): which Whop membership is theirs, and what it says. Nothing
 * here or in ./billing.ts changes anything on Whop.
 */
import type { WhopMembership, WhopOrder } from '../whop'

export type BillingLookup = {
  /** The membership id their Whop sign-up recorded (the journey's "Whop membership mem_…" note). */
  membershipId: string | null
  /** Their emails on file (onboarding form, Clients, tracker, logins), lowercase. */
  emails: string[]
  /** Their website is live (Clients has its link). */
  siteLive: boolean
}

export type Billing = {
  /** How the membership was found, in words. */
  matchedBy: string
  email: string | null
  status: string
  label: string
  tone: 'green' | 'amber' | 'red' | 'gray'
  product: string | null
  /** Whop's own wording, "$297.00 / month". */
  price: string | null
  joinedAt: string | null
  /** The next charge while it renews; the day it ends when it's set to cancel. */
  periodEndsAt: string | null
  /** What periodEndsAt is: the next charge, the first charge after the free month, or the end. */
  periodLabel: string | null
  canceledAt: string | null
  cancellationReason: string | null
  lastPaid: { at: string; amount: number | null; currency: string | null } | null
  paidCount: number
  /** Paid so far, in US dollars (Whop's usd_total), refunds not taken off. */
  paidUsd: number
  refundedUsd: number
  card: string | null
  /** Something to look at, in a sentence. */
  warning: string | null
  /** Their other Whop memberships (an older one that ended, say). */
  otherMemberships: number
}

/** The membership id in the journey's sign-up note ("Whop membership mem_abc123"). */
export function membershipIdFrom(note: string | null | undefined): string | null {
  return /^whop membership\s+(mem_[A-Za-z0-9]+)/i.exec((note ?? '').trim())?.[1] ?? null
}

export const normEmail = (e: string | null | undefined): string | null => {
  const s = (e ?? '').trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null
}

/** Whop memberships that pay, or are about to. */
const LIVE = ['active', 'trialing', 'past_due', 'canceling']

/** Theirs: the one their sign-up recorded, else one with their email (paying first, then the newest). */
export function pickMembership(all: WhopMembership[], q: BillingLookup): { m: WhopMembership; by: string; others: number } | null {
  const emails = new Set(q.emails.map(normEmail).filter((e): e is string => !!e))
  const mine = all.filter((m) => (q.membershipId && m.id === q.membershipId) || (!!normEmail(m.customerEmail) && emails.has(normEmail(m.customerEmail)!)))
  if (!mine.length) return null
  const byId = q.membershipId ? mine.find((m) => m.id === q.membershipId) : undefined
  const time = (m: WhopMembership) => Date.parse(m.joinedAt ?? '') || 0
  const best = byId ?? [...mine].sort((a, b) => Number(LIVE.includes(b.status)) - Number(LIVE.includes(a.status)) || time(b) - time(a))[0]
  return { m: best, by: byId ? 'their Whop sign-up' : `their email (${normEmail(best.customerEmail)})`, others: mine.length - 1 }
}

function labelOf(m: WhopMembership): { label: string; tone: Billing['tone'] } {
  const s = m.status.toLowerCase()
  if (s === 'past_due') return { label: 'Past due', tone: 'red' }
  if (s === 'unresolved') return { label: 'Payment problem', tone: 'red' }
  if ((s === 'active' || s === 'trialing') && m.cancelAtPeriodEnd) return { label: 'Canceling', tone: 'amber' }
  if (s === 'canceling') return { label: 'Canceling', tone: 'amber' }
  if (s === 'active') return { label: 'Paying', tone: 'green' }
  if (s === 'trialing') return { label: 'Free month', tone: 'green' }
  if (s === 'canceled') return { label: 'Canceled', tone: 'gray' }
  if (s === 'completed') return { label: 'Ended', tone: 'gray' }
  if (s === 'expired') return { label: 'Expired', tone: 'gray' }
  return { label: s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), tone: 'gray' }
}

const DAY_MS = 86_400_000
const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

export function billingOf(memberships: WhopMembership[], orders: WhopOrder[], q: BillingLookup, now = new Date()): Billing | null {
  const pick = pickMembership(memberships, q)
  if (!pick) return null
  const { m } = pick
  const email = normEmail(m.customerEmail)
  // Their payments: for this membership when Whop says which, else by their email.
  const theirs = orders.filter((o) => (o.membershipId ? o.membershipId === m.id : !!email && normEmail(o.customerEmail) === email))
  const paid = theirs.filter((o) => o.status === 'paid').sort((a, b) => (Date.parse(b.paidAt ?? b.createdAt ?? '') || 0) - (Date.parse(a.paidAt ?? a.createdAt ?? '') || 0))
  const last = paid.find((o) => !!(o.paidAt ?? o.createdAt))
  const card = [...theirs].reverse().reduce<string | null>((acc, o) => (o.cardLast4 ? `${o.cardBrand ? o.cardBrand.replace(/^\w/, (c) => c.toUpperCase()) : 'Card'} •••• ${o.cardLast4}` : acc), null)
  const { label, tone } = labelOf(m)
  const s = m.status.toLowerCase()
  const ending = m.cancelAtPeriodEnd || s === 'canceling'
  const ended = ['canceled', 'completed', 'expired'].includes(s)
  const periodLabel = !m.periodEndsAt || ended ? null : ending ? 'Ends' : s === 'trialing' ? 'First charge' : 'Next charge'
  const soon = !!m.periodEndsAt && Date.parse(m.periodEndsAt) - now.getTime() <= 7 * DAY_MS && Date.parse(m.periodEndsAt) >= now.getTime() - DAY_MS
  const warning =
    s === 'past_due' || s === 'unresolved'
      ? 'Their last charge didn’t go through.'
      : s === 'trialing' && soon && !q.siteLive
        ? `Their free month ends ${day(m.periodEndsAt!)} and their website isn’t live yet.`
        : ending && m.periodEndsAt
          ? `Set to cancel: it ends ${day(m.periodEndsAt)}${m.cancellationReason ? ` (“${m.cancellationReason}”)` : ''}.`
          : null
  return {
    matchedBy: pick.by,
    email,
    status: m.status,
    label,
    tone,
    product: m.productTitle,
    price: m.renewalPrice,
    joinedAt: m.joinedAt,
    periodEndsAt: periodLabel ? m.periodEndsAt : null,
    periodLabel,
    canceledAt: m.canceledAt,
    cancellationReason: m.cancellationReason,
    lastPaid: last ? { at: (last.paidAt ?? last.createdAt)!, amount: last.total, currency: last.currency } : null,
    paidCount: paid.length,
    paidUsd: Math.round(paid.reduce((n, o) => n + (o.usdTotal ?? 0), 0) * 100) / 100,
    refundedUsd: Math.round(paid.reduce((n, o) => n + ((o.currency ?? 'usd').toLowerCase() === 'usd' ? (o.refunded ?? 0) : 0), 0) * 100) / 100,
    card,
    warning,
    otherMemberships: pick.others,
  }
}
