import { after, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { canAccessSeo } from './access'
import { SeoInputError } from './actions'
import { runSeoTick } from './engine'

/** The signed-in user's email when they may use SEO, else a 403 response to return. */
export async function seoGuard(): Promise<{ email: string } | NextResponse> {
  const session = await auth()
  const email = session?.user?.email
  if (!email || !canAccessSeo(email)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  return { email }
}

export function seoError(err: unknown, where: string): NextResponse {
  if (err instanceof SeoInputError) return NextResponse.json({ error: err.message }, { status: 400 })
  console.error(`[seo] ${where} failed:`, err)
  return NextResponse.json({ error: err instanceof Error ? err.message : 'Something went wrong.' }, { status: 500 })
}

/** Nudge the engine after a change so the person doesn't wait for the next minute tick. */
export function kickEngine(): void {
  after(() => runSeoTick().then(() => undefined, (err) => console.error('[seo] kick failed:', err)))
}
