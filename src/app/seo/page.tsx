import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import { canAccessSeo } from '@/lib/seo/access'
import { SeoDashboard } from './seo-dashboard'

/**
 * /seo — the weekly SEO engine for client sites. Same email allowlist as
 * Payments (owner + Ethan), not role=admin: the engine commits to client
 * repos, so Mary and Hannah must not reach it even though they're admins.
 * The API routes enforce the same gate; this redirect just keeps the page
 * itself closed.
 */
export default async function SeoPage() {
  const session = await auth()
  if (!canAccessSeo(session?.user?.email)) {
    redirect('/today')
  }

  return <SeoDashboard />
}
