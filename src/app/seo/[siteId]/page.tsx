import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import { canAccessSeo } from '@/lib/seo/access'
import { SiteView } from './site-view'

/** /seo/[siteId] — one site: score trend, runs, posts, business facts, settings. */
export default async function SeoSitePage({ params }: { params: Promise<{ siteId: string }> }) {
  const session = await auth()
  if (!canAccessSeo(session?.user?.email)) {
    redirect('/today')
  }
  const { siteId } = await params

  return <SiteView siteId={siteId} />
}
