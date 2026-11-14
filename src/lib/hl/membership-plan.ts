/**
 * A client's membership with Genisys, for Hell-level → Memberships (Alex, 2026-11-14: "record when
 * the client registered and received their sub-account"). Pure (tests load it): the dates come from
 * records the Hub keeps anyway, read by src/app/api/hl/accounts/[id]/membership/route.ts.
 */

export type MembershipFacts = {
  /** The client journey's sign-up step, with its note ("Whop membership …" when Whop's webhook set it). */
  signupStep: { note: string | null; completedAt: Date | null } | null
  /** The journey's sub-account step ("Created sub-account …" when the Hub made it in GoHighLevel). */
  subAccountStep: { note: string | null; completedAt: Date | null } | null
  /** The first onboarding form they sent. */
  firstIntakeAt: Date | null
  /** "Start Date" on the Client Onboarding Tracker sheet, as typed there. */
  trackerStart: string | null
  /** When the client was added to the Hub. */
  clientAddedAt: Date | null
  /** The Hub's own GoHighLevel sub-account step: created | linked | failed | …, and when. */
  ghlProvision: { status: string | null; at: Date | null }
  /** GoHighLevel's own date for the sub-account (its location record), when it gives one. */
  ghlLocationAddedAt: Date | null
  /** This Hell-level sub-account. */
  accountCreatedAt: Date
  /** Copied in from GoHighLevel (that location), or made in Hell-level (null). */
  ghlLocationId: string | null
  siteLiveAt: Date | null
  siteUrl: string | null
  numbers: { number: string; kind: string; createdAt: Date; verificationStatus: string; verificationAt: Date | null }[]
  domains: { name: string; createdAt: Date }[]
  logins: { who: string; invitedAt: Date; lastLoginAt: Date | null }[]
  archivedAt: Date | null
  lifecycle: string | null
}

/** A date and what it is, in words. */
export type Dated = { at: string; label: string }

export type Membership = {
  /** When they signed up with Genisys, and which record says so. */
  registered: { at: string; how: string } | null
  /** When they got their sub-account (GoHighLevel's for a client from before Hell-level). */
  subAccount: { at: string | null; how: string }
  /** When a GoHighLevel sub-account was copied into Hell-level. */
  copiedAt: string | null
  daysAsClient: number | null
  /** What happened, oldest first. */
  timeline: Dated[]
  /** What's still to come for their setup. */
  next: string[]
  /** Archived or churned: when, in words. */
  ended: string | null
}

const DAY_MS = 86_400_000

/** "10/14/2026", "2026-10-14" or "Oct 14, 2026" from the tracker sheet; null when it isn't a date. */
export function parseSheetDate(v: string | null | undefined): Date | null {
  const s = (v ?? '').trim()
  if (!s) return null
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s)
  // A day that doesn't exist ("13/45/2026") is no date, not one rolled over into another month.
  const ymd = (y: number, m: number, day: number) => {
    const x = new Date(Date.UTC(y, m - 1, day, 12))
    return x.getUTCFullYear() === y && x.getUTCMonth() === m - 1 && x.getUTCDate() === day ? x : null
  }
  let d: Date | null = null
  if (iso) d = ymd(+iso[1], +iso[2], +iso[3])
  else if (us) d = ymd(us[3].length === 2 ? 2000 + +us[3] : +us[3], +us[1], +us[2])
  else if (/[a-z]{3}/i.test(s) && /\d{4}/.test(s)) {
    const t = Date.parse(`${s} 12:00 UTC`)
    d = Number.isNaN(t) ? null : new Date(t)
  }
  if (!d || Number.isNaN(d.getTime())) return null
  const y = d.getUTCFullYear()
  return y >= 2020 && y <= 2100 ? d : null
}

/** Whop's webhook writes "Whop membership …" on the sign-up step; the intake form writes "Implied by intake form". */
const fromWhop = (note: string | null | undefined) => /^whop membership/i.test(note ?? '')
/** The Hub made the GoHighLevel sub-account (not linked to one someone made by hand). */
const madeByHub = (note: string | null | undefined) => /^created sub-account/i.test(note ?? '')

/**
 * When they registered: the earliest record of them, preferring the plainest one within a day of it
 * (the Hub adds a client the moment their onboarding form lands, a few milliseconds apart).
 */
export function registeredFrom(f: MembershipFacts): { at: Date; how: string } | null {
  const cands: { at: Date | null; how: string }[] = [
    { at: fromWhop(f.signupStep?.note) ? (f.signupStep?.completedAt ?? null) : null, how: 'Signed up on Whop' },
    { at: f.firstIntakeAt, how: 'Sent the onboarding form' },
    { at: parseSheetDate(f.trackerStart), how: 'Start date on the onboarding tracker' },
    { at: f.clientAddedAt, how: 'Added to the Hub' },
  ]
  const known = cands.filter((c): c is { at: Date; how: string } => !!c.at)
  if (!known.length) return null
  const first = Math.min(...known.map((c) => c.at.getTime()))
  // Of those within a day of the first, the one higher on the list (cands is in order of preference).
  const pick = known.find((c) => c.at.getTime() - first <= DAY_MS)!
  return { at: pick.at, how: pick.how }
}

/** When they got their sub-account, and how the Hub knows. */
export function subAccountFrom(f: MembershipFacts): { at: Date | null; how: string; copiedAt: Date | null } {
  if (!f.ghlLocationId) return { at: f.accountCreatedAt, how: 'Hell-level sub-account made', copiedAt: null }
  const made =
    f.ghlLocationAddedAt ??
    (f.ghlProvision.status === 'created' ? f.ghlProvision.at : null) ??
    (madeByHub(f.subAccountStep?.note) ? (f.subAccountStep?.completedAt ?? null) : null)
  return {
    at: made,
    how: made ? 'GoHighLevel sub-account made' : 'Made in GoHighLevel (GoHighLevel doesn’t give the date)',
    copiedAt: f.accountCreatedAt,
  }
}

const iso = (d: Date) => d.toISOString()
const pretty = (n: string) => {
  const d = n.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : n
}
const host = (url: string | null) => (url ?? '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '')

export function membershipOf(f: MembershipFacts, now = new Date()): Membership {
  const reg = registeredFrom(f)
  const sub = subAccountFrom(f)
  const timeline: { at: Date; label: string }[] = []
  const add = (at: Date | null | undefined, label: string) => {
    if (at && !Number.isNaN(at.getTime())) timeline.push({ at, label })
  }
  if (fromWhop(f.signupStep?.note)) add(f.signupStep?.completedAt, 'Signed up on Whop')
  add(f.firstIntakeAt, 'Sent the onboarding form')
  if (!f.firstIntakeAt && !fromWhop(f.signupStep?.note) && reg) add(reg.at, reg.how)
  add(sub.at, sub.at && f.ghlLocationId ? 'Got their GoHighLevel sub-account' : 'Got their Hell-level sub-account')
  if (sub.copiedAt) add(sub.copiedAt, 'Copied into Hell-level from GoHighLevel')
  for (const l of f.logins) add(l.invitedAt, `Hell-level login sent to ${l.who}`)
  add(f.siteLiveAt, `Website live${f.siteUrl ? ` at ${host(f.siteUrl)}` : ''}`)
  for (const d of f.domains) add(d.createdAt, `Domain ${d.name} added`)
  for (const n of f.numbers) {
    add(n.createdAt, `${n.kind === 'toll_free' || n.kind === 'tollfree' ? 'Toll-free' : 'Phone'} number ${pretty(n.number)}`)
    if (n.verificationStatus === 'approved') add(n.verificationAt, `Texting approved on ${pretty(n.number)}`)
  }
  timeline.sort((a, b) => a.at.getTime() - b.at.getTime())

  const next: string[] = []
  if (!f.siteLiveAt && !f.siteUrl) next.push('Website live')
  // A client from GoHighLevel may still text from GoHighLevel's number: only a Hell-level one is asked for here.
  if (!f.numbers.length) {
    if (!f.ghlLocationId) next.push('A phone number')
  } else if (!f.numbers.some((n) => n.verificationStatus === 'approved')) next.push('Texting approved (carrier verification)')

  const churned = (f.lifecycle ?? '').toLowerCase() === 'churned'
  return {
    registered: reg ? { at: iso(reg.at), how: reg.how } : null,
    subAccount: { at: sub.at ? iso(sub.at) : null, how: sub.how },
    copiedAt: sub.copiedAt ? iso(sub.copiedAt) : null,
    daysAsClient: reg ? Math.max(0, Math.floor((now.getTime() - reg.at.getTime()) / DAY_MS)) : null,
    timeline: timeline.map((t) => ({ at: iso(t.at), label: t.label })),
    next: f.archivedAt || churned ? [] : next,
    ended: f.archivedAt ? `Archived ${f.archivedAt.toISOString().slice(0, 10)}` : churned ? 'Churned' : null,
  }
}
