import { prisma } from '@/lib/prisma'

/**
 * Every client the Hub knows about gets a seat in SEO automatically.
 *
 * A client arrives through the onboarding form; the moment their Client
 * row exists, an SEO site is created for them in Audit mode. It costs
 * nothing until it has a live URL to look at (runs skip a site with no
 * URL and no repo), so nobody has to remember to add them later. When the
 * site we built goes live — Client.siteUrl is set — the SEO site follows.
 */

export async function ensureSeoSiteForClient(clientId: string): Promise<string | null> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      name: true,
      siteUrl: true,
      archivedAt: true,
      seoSite: { select: { id: true, liveUrl: true, archivedAt: true } },
    },
  })
  if (!client || client.archivedAt) return null
  if (client.seoSite) {
    if (!client.seoSite.archivedAt && !client.seoSite.liveUrl && client.siteUrl) {
      await prisma.seoSite.update({ where: { id: client.seoSite.id }, data: { liveUrl: client.siteUrl } })
    }
    return client.seoSite.id
  }
  const site = await prisma.seoSite.create({
    data: { clientId: client.id, name: client.name, liveUrl: client.siteUrl, mode: 'audit', enabled: true },
    select: { id: true },
  })
  return site.id
}

/** The site we built for a client changed address — the SEO site audits the new one. */
export async function syncSeoSiteLiveUrl(clientId: string, siteUrl: string | null): Promise<void> {
  if (!siteUrl) return
  const res = await prisma.seoSite.updateMany({ where: { clientId, archivedAt: null }, data: { liveUrl: siteUrl } })
  // No seat: a client added by hand, who never went through the onboarding form.
  if (!res.count) await ensureSeoSiteForClient(clientId)
}

/**
 * Every client in Sites with a live site has a seat, however they came in: without one the domain guard
 * and Search Console never look at the site, and nothing says so (A Plus Fence, added by hand, until
 * 2026-11-24). A seat someone archived stays archived. Returns how many were missing.
 */
export async function seatLiveSites(): Promise<number> {
  const missing = await prisma.client.findMany({
    where: {
      archivedAt: null,
      lifecycle: { notIn: ['churned', 'denied'] },
      hlAccount: { is: { archivedAt: null } },
      AND: [{ siteUrl: { not: null } }, { siteUrl: { not: '' } }],
      OR: [{ seoSite: { is: null } }, { seoSite: { is: { archivedAt: null, liveUrl: null } } }],
    },
    select: { id: true, name: true },
    take: 25,
  })
  for (const c of missing) {
    const siteId = await ensureSeoSiteForClient(c.id)
    if (siteId) console.log(`[seo] ${c.name}: its live site wasn't in the SEO list; added`)
  }
  return missing.length
}
