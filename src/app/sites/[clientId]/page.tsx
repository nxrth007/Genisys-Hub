import { notFound, redirect } from 'next/navigation'
import { auth } from '@/auth'
import { getSiteDetail } from '@/lib/sites'
import { canAccessSeo } from '@/lib/seo/access'
import { SiteDetailView } from '@/components/sites/site-detail'

/**
 * /sites/:clientId — one client's folder, opened: the Site and Repo pickers
 * at the top (as on the Clients page), their status, a link to their
 * website, and the toll-free number (and details) the site build needs.
 * Staff only; asking for a number in the Office is admin only.
 */
export const metadata = { title: 'Site · Genisys Hub' }
export const dynamic = 'force-dynamic'

export default async function SitePage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await auth()
  const role = (session?.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') redirect('/today')
  const { clientId } = await params
  const detail = await getSiteDetail(clientId)
  if (!detail) notFound()
  // ?builder=1 (the Office's link for connecting a domain) opens the builder window straight away.
  const { builder } = await searchParams
  // "Check now" on the On Google card can change the site's code: the SEO allowlist (Alex + Ethan) only.
  return <SiteDetailView d={detail} canAsk={role === 'admin'} canCheckGoogle={canAccessSeo(session?.user?.email)} openBuilder={builder === '1'} />
}
