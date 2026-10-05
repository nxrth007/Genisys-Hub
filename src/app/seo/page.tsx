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
export default async function SeoPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await auth()
  if (!canAccessSeo(session?.user?.email)) {
    redirect('/today')
  }
  // Coming back from Google after "Connect Search Console".
  const sp = await searchParams
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null
  const ok = one(sp.gsc_connected)
  const err = one(sp.gsc_error)
  const gscNotice = ok ? { tone: 'ok' as const, text: `Search Console connected as ${ok}. The Hub now connects each site on its own.` } : err ? { tone: 'err' as const, text: err } : undefined

  return <SeoDashboard gscNotice={gscNotice} />
}
