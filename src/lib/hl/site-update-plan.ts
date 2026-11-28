/**
 * "Send Site Update" in a client's Sites folder (Alex, 2026-11-25): once their site is live on its
 * own domain, a text to the owner from Lead Genisys's GHL sub-account with the link to the first
 * draft, and their Genisys OS login. The decisions, pure (tests load it); ./site-update.ts does it.
 */
import { EMAIL_RE, digits10, firstName } from '../gbp-plan'
import { emailList, phoneList } from './phone'

/** Each client's sends, last 20 (AppSetting). */
export const SITE_UPDATE_LOG_KEY = 'hl.siteUpdate:'

/** Addresses a site has before its own domain is connected, and the Hub's own. */
const NOT_THEIRS = /(^|\.)(lovable\.app|lovableproject\.com|onrender\.com)$/i
const OUR_EMAIL = /@(?:leadgenisys|peakfinitylabs)\.com$/i
const TOLL_FREE = /^8(?:00|33|44|55|66|77|88)/

/** "https://www.acmeroofing.com/" → "acmeroofing.com"; null when blank, unreadable, or not their own domain yet. */
export function ownDomain(siteUrl: string | null | undefined): string | null {
  const raw = (siteUrl ?? '').trim()
  if (!raw) return null
  try {
    const host = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./, '')
    return host && !NOT_THEIRS.test(host) ? host : null
  } catch {
    return null
  }
}

/** The button shows once the site is live (the Clients page has its link) on their own domain. */
export function siteUpdateReady(c: { siteUrl: string | null | undefined; archivedAt?: unknown }): { ready: boolean; why: string | null } {
  if (c.archivedAt) return { ready: false, why: 'This client is archived.' }
  if (!(c.siteUrl ?? '').trim()) return { ready: false, why: 'The site isn’t live yet: add the site link on Clients once it is.' }
  if (!ownDomain(c.siteUrl)) return { ready: false, why: 'The site is still on its Lovable address: connect their domain first.' }
  return { ready: true, why: null }
}

export type OwnerContactFacts = {
  /** Their Genisys OS Business Profile: where the owner's own alerts go. */
  profile: { ownerFirstName?: string | null; ownerName?: string | null; notifyPhone?: string | null; notifyEmail?: string | null }
  contactName: string | null
  contactPhone: string | null
  contactEmail: string | null
  /** The onboarding form's answers. */
  intake: { fullName: string | null; customerPhone: string | null; leadEmail: string | null } | null
  /** Numbers that are never the owner's: the team's own, and the business's Genisys OS numbers. */
  notOwner: string[]
}

/**
 * Who the text goes to: where their Genisys OS alerts go first, then the contact on Clients, then
 * the onboarding form. Never our own phones or emails, nor a toll-free line. The first name to
 * greet them by is blank when none of the names is a person's.
 */
export function ownerContact(f: OwnerContactFacts): { phone: string | null; email: string | null; firstName: string } {
  const skip = new Set(f.notOwner.map(digits10).filter(Boolean))
  const phones = [...phoneList(f.profile.notifyPhone), f.contactPhone, f.intake?.customerPhone].map(digits10).filter((d) => d.length === 10 && !skip.has(d) && !TOLL_FREE.test(d))
  const emails = [...emailList(f.profile.notifyEmail), f.contactEmail, f.intake?.leadEmail].map((e) => (e ?? '').trim().toLowerCase()).filter((e) => EMAIL_RE.test(e) && !OUR_EMAIL.test(e))
  return {
    phone: phones[0] ?? null,
    email: emails[0] ?? null,
    firstName: firstName(f.profile.ownerFirstName) || firstName(f.profile.ownerName) || firstName(f.contactName) || firstName(f.intake?.fullName),
  }
}

export type SiteUpdateLogin = { link: string; email: string; signInUrl: string }

/** Alex's words (2026-11-25), the site link on its own line, and their login when one goes with it. */
export function siteUpdateText(o: { firstName: string; siteUrl: string; login: SiteUpdateLogin | null }): string {
  const lines = [
    `Hey ${o.firstName || 'there'}. We've got the first draft of your website ready for you to preview here:`,
    o.siteUrl,
    '',
    "The forms on the website won't work for a few days. It's still a work in progress, so let us know what changes you'd like to make!",
    '',
    'We are working on your SEO (which will drive leads to your site) and will keep you updated.',
    '',
    'Please text us all changes, questions, and concerns. Thanks!',
  ]
  if (o.login) {
    lines.push('', 'Your Genisys OS login (your leads, texts and calendar in one place): set your password here, the link works for 7 days:', o.login.link, `Then sign in any time at ${o.login.signInUrl} with ${o.login.email}`)
  }
  return lines.join('\n')
}

export type SiteUpdateSent = { at: string; to: string; by: string; login: string | null; ok: boolean; detail: string | null }

export function readSentLog(raw: string | null | undefined): SiteUpdateSent[] {
  try {
    const v = JSON.parse(raw ?? '') as unknown
    return Array.isArray(v) ? v.filter((x): x is SiteUpdateSent => !!x && typeof x === 'object' && typeof (x as SiteUpdateSent).at === 'string' && typeof (x as SiteUpdateSent).to === 'string') : []
  } catch {
    return []
  }
}

/** GET /api/clients/:id/site-update. */
export type SiteUpdateView = {
  ready: boolean
  why: string | null
  business: string
  firstName: string
  siteUrl: string | null
  /** The owner's number (10 digits) and email as the Hub knows them; changed in the preview if wrong. */
  to: string | null
  email: string | null
  /** They have a Genisys OS sub-account, so a login can go in the text. */
  canLogin: boolean
  /** Emails that already have a login there. */
  logins: string[]
  signInUrl: string
  last: SiteUpdateSent | null
}

export const prettyPhone = (n: string): string => {
  const d = digits10(n)
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : n
}
