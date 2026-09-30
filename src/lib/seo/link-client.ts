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
  await prisma.seoSite.updateMany({ where: { clientId, archivedAt: null }, data: { liveUrl: siteUrl } })
}
