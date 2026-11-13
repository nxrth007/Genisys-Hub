import { notFound, redirect } from 'next/navigation'
import { auth } from '@/auth'
import { getSiteDetail } from '@/lib/sites'
import { SiteDetailView } from '@/components/sites/site-detail'

/**
 * /sites/:clientId — one client's folder, opened: their status, a link to
 * their website, and the toll-free number (and details) the site build needs.
 * Staff only; asking for a number in the Office is admin only.
 */
export const metadata = { title: 'Site · Genisys Hub' }
export const dynamic = 'force-dynamic'

export default async function SitePage({ params }: { params: Promise<{ clientId: string }> }) {
  const session = await auth()
  const role = (session?.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') redirect('/today')
  const { clientId } = await params
  const detail = await getSiteDetail(clientId)
  if (!detail) notFound()
  return <SiteDetailView d={detail} canAsk={role === 'admin'} />
}
