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
    default:
      return o.siteLive
        ? 'Texting verification not filed yet: the Hub files it within minutes of the site link going in.'
        : 'Texting verification is filed by itself once the site link is in (it needs the live site).'
  }
}
