import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { hlAccountGuard } from '@/lib/hl/http'
import { bareHost, SITE_STATUS_TEXT, type SiteStatus } from '@/lib/hl/site-plan'
import { lovableProjectPublic } from '@/lib/seo/lovable-mcp'
import { siteHref } from '@/lib/site-status'

/**
 * GET /api/hl/accounts/:id/website — the client's own website, for Hell-level → Sites → Websites
 * (Alex, 2026-11-14: "can we have the client's sites show up here"). It's the site Forge built in
 * Lovable (where it stands, where it's live), else the site link in Clients, with a picture of the
 * latest build from Lovable. Genisys staff also get the Hub's folder, its builder window and the
 * Lovable project; a contractor on the sub-account sees the site itself.
 */
export const dynamic = 'force-dynamic'

/** Forge's statuses in which the site is out on the web. */
const LIVE = ['published', 'connecting', 'connected']

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const guard = await hlAccountGuard(id)
  if (guard instanceof NextResponse) return guard
  const account = await prisma.hlAccount.findUnique({ where: { id }, select: { clientId: true } })
  if (!account) return NextResponse.json({ error: 'Sub-account not found' }, { status: 404 })
  if (!account.clientId) return NextResponse.json({ site: null })
  const c = await prisma.client.findUnique({
    where: { id: account.clientId },
    select: {
      id: true,
      siteUrl: true,
      siteLiveAt: true,
      hlSiteRequest: { select: { status: true, liveUrl: true, domain: true, publishedAt: true, domainAt: true, projectId: true } },
      seoSite: { select: { lovableProjectId: true } },
    },
  })
  if (!c) return NextResponse.json({ site: null })
  const forge = c.hlSiteRequest
  const linked = c.siteUrl?.trim() ? siteHref(c.siteUrl.trim()) : null
  const forgeUrl = forge?.status === 'connected' && forge.domain ? `https://${forge.domain}` : forge && LIVE.includes(forge.status) ? forge.liveUrl : null
  const url = forgeUrl ?? linked
  const projectId = forge?.projectId ?? c.seoSite?.lovableProjectId ?? null
  if (!url && !forge && !projectId) return NextResponse.json({ site: null })
  const lovable = projectId ? await lovableProjectPublic(projectId).catch(() => null) : null
  const status = forge?.status ?? (linked ? 'live' : 'none')
  return NextResponse.json({
    site: {
      url,
      host: bareHost(url),
      status,
      label: forge ? (SITE_STATUS_TEXT[forge.status as SiteStatus] ?? forge.status) : linked ? 'Live' : 'No site yet',
      live: !!url && (!forge || LIVE.includes(forge.status)),
      liveSince: (forge?.domainAt ?? forge?.publishedAt ?? c.siteLiveAt)?.toISOString() ?? null,
      /** Their domain while Forge connects it. */
      connecting: forge?.status === 'connecting' ? forge.domain : null,
      /** The site link in Clients when it's another address (an older site, say). */
      clientsLink: linked && bareHost(linked) !== bareHost(url) ? linked : null,
      screenshot: lovable?.screenshotUrl ?? null,
      builtByForge: !!forge,
      staff: guard.admin
        ? {
            folder: `/sites/${c.id}`,
            builder: projectId ? `/sites/${c.id}?builder=1` : null,
            lovable: projectId ? `https://lovable.dev/projects/${projectId}` : null,
          }
        : null,
    },
  })
}
