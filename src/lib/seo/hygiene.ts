import { prisma } from '@/lib/prisma'
import { looksLikePhoneNumber } from '@/lib/client-from-intake'
import { archiveSite } from './actions'

/**
 * Sites that should never have been on the SEO page.
 *
 * Every onboarding submission used to become a Client and an SEO site
 * under whatever was typed as the business name — once, a phone number
 * ("8302379649"). Clients like that are no longer created, and a deleted
 * client's site is archived with it, but anything made before those
 * fixes is still listed. This archives, once per engine tick:
 *   - a site whose name is a phone number (nobody runs SEO for "8302379649");
 *   - a site whose client is archived.
 * Archiving is what the Archive button does: the row leaves the SEO page,
 * runs in flight stop, nothing is deleted.
 */
export async function archiveStraySeoSites(): Promise<string[]> {
  const archived: string[] = []
  try {
    const sites = await prisma.seoSite.findMany({
      where: { archivedAt: null },
      select: { id: true, name: true, client: { select: { archivedAt: true } } },
    })
    for (const s of sites) {
      const why = looksLikePhoneNumber(s.name.trim())
        ? 'its name is a phone number'
        : s.client?.archivedAt
          ? 'its client is archived'
          : null
      if (!why) continue
      await archiveSite(s.id)
      archived.push(s.name)
      console.log(`[seo] archived stray site "${s.name}": ${why}`)
    }
  } catch (err) {
    console.error('[seo] stray-site sweep failed:', err)
  }
  return archived
}
