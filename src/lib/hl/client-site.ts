import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { readProfile } from './accounts'
import { fillLegalLinksFromSite } from './legal-links'
import { fillLogoFromSite } from './logo'

/**
 * The site we built for a client went live (or moved to a new address): its
 * Hell-level sub-account follows. A sub-account is made the moment the client
 * onboards, usually before their site exists, so its website starts blank
 * (or as the domain they named). Now it takes the new site, reads the site's
 * privacy and terms pages for the forms and texting registration, and finds
 * the logo there.
 */

const host = (u: string | null | undefined) => {
  try {
    return u ? new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, '').toLowerCase() : null
  } catch {
    return null
  }
}

export async function syncClientSite(clientId: string, siteUrl: string, priorSiteUrl: string | null): Promise<void> {
  const account = await prisma.hlAccount.findUnique({ where: { clientId }, select: { id: true, profile: true } })
  if (!account) return
  const p = readProfile(account.profile)
  // A website someone typed for another address stays; a blank one, or the old site's, becomes the new site.
  const current = host(p.website)
  if (!current || current === host(priorSiteUrl) || current === host(siteUrl)) {
    await prisma.hlAccount.update({ where: { id: account.id }, data: { profile: { ...p, website: siteUrl } as Prisma.InputJsonValue } })
  }
  await fillLegalLinksFromSite(account.id, true)
  // A logo the old site gave way to the new site's; one set by hand (from elsewhere) stays.
  const logoFromOldSite = !!p.logoUrl && !!priorSiteUrl && host(p.logoUrl) === host(priorSiteUrl)
  await fillLogoFromSite(account.id, logoFromOldSite)
}
