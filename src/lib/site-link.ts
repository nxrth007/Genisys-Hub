import { prisma } from '@/lib/prisma'
import { queueCustomizeForSite } from '@/lib/ghl-customize/queue'
import { syncClientSite } from '@/lib/hl/client-site'
import { syncSeoSiteLiveUrl } from '@/lib/seo/link-client'

/**
 * The site we built for a client went live or moved (Clients: siteUrl). One
 * place for what follows, whether a person saved the link in Clients or
 * Forge did once their domain showed the site.
 */

/** What follows a new site link: the SEO site, their Hell-level sub-account (policy pages, logo, texting verification), their GHL lead workflows. Never throws. */
export function afterSiteLinkChange(clientId: string, siteUrl: string, priorSiteUrl: string | null): void {
  // The SEO site audits the new address.
  void syncSeoSiteLiveUrl(clientId, siteUrl).catch((err) => console.warn('[clients] seo site url sync failed:', err))
  // Their Hell-level sub-account takes the site as its website, with its policy pages and logo.
  void syncClientSite(clientId, siteUrl, priorSiteUrl).catch((err) => console.warn('[clients] hell-level site sync failed:', err))
  // Their GHL lead workflows get the copy with this link (when automatic customizing is on).
  void queueCustomizeForSite(clientId)
}

/**
 * Save the site link the way the Clients page does: siteLiveAt marks the
 * first link (the Home globe's launch arc), then afterSiteLinkChange.
 * Returns the link it replaced.
 */
export async function saveSiteLink(clientId: string, siteUrl: string): Promise<{ prior: string | null; changed: boolean }> {
  const prior = (await prisma.client.findUnique({ where: { id: clientId }, select: { siteUrl: true } }))?.siteUrl ?? null
  if (prior === siteUrl) return { prior, changed: false }
  await prisma.client.update({ where: { id: clientId }, data: { siteUrl, ...(prior ? {} : { siteLiveAt: new Date() }) } })
  afterSiteLinkChange(clientId, siteUrl, prior)
  return { prior, changed: true }
}
