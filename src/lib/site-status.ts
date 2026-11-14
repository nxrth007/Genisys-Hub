/**
 * A client's website as the Sites page shows it. Pure (no imports) so it is
 * unit-tested; src/lib/sites.ts does the queries.
 *
 * live: the Clients page has the site we built (Client.siteUrl), the same
 * link that files their toll-free texting verification. Otherwise the
 * website stage of their journey says whether it's being built or blocked.
 */

export type SiteStatus = 'live' | 'building' | 'blocked' | 'needs_site'

export function siteStatus(c: { siteUrl: string | null | undefined; websiteStage?: string | null }): SiteStatus {
  if (c.siteUrl?.trim()) return 'live'
  if (c.websiteStage === 'in_progress') return 'building'
  if (c.websiteStage === 'blocked') return 'blocked'
  return 'needs_site'
}

export const SITE_STATUS_LABEL: Record<SiteStatus, string> = {
  live: 'Site live',
  building: 'Being built',
  blocked: 'Build blocked',
  needs_site: 'Needs a site',
}

/** "https://www.acmeroofing.com/" → "acmeroofing.com". */
export function siteHost(url: string | null | undefined): string {
  if (!url?.trim()) return ''
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** A link that opens: "acmeroofing.com" → "https://acmeroofing.com". */
export function siteHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`
}

const ORDER: Record<SiteStatus, number> = { blocked: 0, needs_site: 1, building: 2, live: 3 }

/** Folders that need a site first (blocked, not started, being built), then live ones; by name within each. */
export function sortFolders<T extends { status: SiteStatus; name: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name))
}

export type StageFacts = {
  /** The Clients page has the site link. */
  siteLive: boolean
  /** A GHL sub-account is linked to the client. */
  ghlLinked: boolean
  /** Their Hell-level sub-account: when it was made, and whether it's archived. Null without one. */
  hellLevel?: { createdAt: string; archived: boolean } | null
  /** An onboarding form came in for the client. */
  hasIntake: boolean
  /** The site number's toll-free texting verification, when it has one: none | pending | in_review | approved | rejected. */
  texting: string | null
}

/**
 * A journey stage as the folder shows it. Clients from before the journey
 * tracker have no stage rows, so what the Hub knows wins: a site link means
 * the website is done, an approved toll-free number means texting is
 * registered, and so on. A stage with no row and no fact says "none" (No
 * record) rather than "Not started".
 */
export function stageView(stage: string, row: { status: string; note: string | null; updatedAt: string | null }, f: StageFacts): { status: string; note: string | null } {
  if (stage === 'website' && f.siteLive) return { status: 'done', note: row.status === 'done' ? row.note : 'Site link is on the Clients page' }
  if (stage === 'a2p' && f.texting && f.texting !== 'none') {
    if (f.texting === 'approved') return { status: 'done', note: 'Toll-free texting approved' }
    if (f.texting === 'rejected') return { status: 'blocked', note: 'Toll-free texting verification rejected' }
    return { status: 'in_progress', note: 'Toll-free texting verification is with Twilio' }
  }
  if (stage === 'subaccount' && f.ghlLinked && row.status !== 'done') return { status: 'done', note: 'GHL sub-account linked' }
  // Hell-level only (new clients since 2026-11-13): no GHL sub-account is made for them, so
  // the GHL row isn't waiting on anyone, whatever its old "create it in GHL" note says.
  if (stage === 'subaccount' && !f.ghlLinked && f.hellLevel && !f.hellLevel.archived && row.status !== 'done') {
    return { status: 'not_needed', note: 'Hell-level only: no GHL sub-account' }
  }
  if (stage === 'intake' && f.hasIntake && row.status !== 'done') return { status: 'done', note: 'Onboarding form received' }
  if (!row.updatedAt && row.status === 'pending') return { status: 'none', note: null }
  return { status: row.status, note: row.note }
}

/**
 * The Hell-level sub-account as a Status row, listed just before the GHL one. It isn't a
 * journey stage: the Hub knows it from the sub-account itself (made at onboarding).
 */
export function hellLevelStage(hl: StageFacts['hellLevel']): { status: string; note: string | null } {
  if (!hl) return { status: 'none', note: null }
  if (hl.archived) return { status: 'none', note: 'Archived in Hell-level' }
  const made = new Date(hl.createdAt)
  const day = Number.isNaN(made.getTime()) ? '' : made.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })
  return { status: 'done', note: day ? `Set up ${day}` : 'Set up' }
}

/** What a toll-free number's texting verification means for the site build, in a sentence. */
export function textingLine(o: { verificationStatus: string | null; verificationNote?: string | null; siteLive: boolean }): string {
  switch (o.verificationStatus) {
    case 'approved':
      return 'Texting approved: texts go out from this number.'
    case 'pending':
    case 'in_review':
      return 'Texting verification filed; Twilio is reviewing it (about 3 business days).'
    case 'rejected':
      return `Texting verification rejected${o.verificationNote ? `: ${o.verificationNote}` : ''}. Fix it and file again in Hell-level.`
    case 'ghl':
      return 'This number is in GHL: texts and calls land in GHL, and its toll-free registration goes through GHL’s own form once the site is live.'
    default:
      return o.siteLive
        ? 'Texting verification not filed yet: the Hub files it within minutes of the site link going in.'
        : 'Texting verification is filed by itself once the site link is in (it needs the live site).'
  }
}
