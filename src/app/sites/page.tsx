import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import { listSiteFolders } from '@/lib/sites'
import { SitesGrid } from '@/components/sites/sites-grid'

/**
 * /sites — every client's website as a folder: ✓ when the site is live, !
 * when they still need one. Staff only (admin/member), like the Office.
 */
export const metadata = { title: 'Sites · Genisys Hub' }
export const dynamic = 'force-dynamic'

export default async function SitesPage() {
  const session = await auth()
  const role = (session?.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') redirect('/today')
  return <SitesGrid folders={await listSiteFolders()} />
}
