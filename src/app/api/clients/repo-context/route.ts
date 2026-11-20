import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/clients/repo-context
 *
 * What the Site and Repo pickers need outside the Clients page (a client's
 * folder in Sites): every client's site link, linked repo, owners' names and
 * addresses, so the Repo dropdown can grey out a repo another client holds
 * and show the Hub's guess (src/lib/site-match.ts) in green, the same way the
 * Clients page does from its roster. A fraction of the roster: no onboarding
 * answers, no GHL lookups. Staff only.
 */
export async function GET() {
  const denied = await requireStaff()
  if (denied) return denied
  const clients = await prisma.client.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      archivedAt: true,
      siteUrl: true,
      website: true,
      contactName: true,
      contactEmail: true,
      intakes: { orderBy: { receivedAt: 'desc' }, take: 1, select: { fullName: true, domainName: true, website: true, leadEmail: true } },
      seoSite: { select: { id: true, repoFullName: true, archivedAt: true } },
    },
  })
  return NextResponse.json({
    clients: clients.map((c) => {
      const i = c.intakes[0]
      return {
        id: c.id,
        name: c.name,
        siteUrl: c.siteUrl,
        archivedAt: c.archivedAt ? c.archivedAt.toISOString() : null,
        // The same as the roster's: an archived SEO site holds no repo.
        seo: c.seoSite && !c.seoSite.archivedAt ? { siteId: c.seoSite.id, repoFullName: c.seoSite.repoFullName } : null,
        people: [c.contactName, i?.fullName ?? null],
        addresses: [c.siteUrl, c.website, i?.domainName ?? null, i?.website ?? null, c.contactEmail, i?.leadEmail ?? null],
      }
    }),
  })
}
