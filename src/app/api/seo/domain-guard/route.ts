import { NextRequest, NextResponse } from 'next/server'
import { domainGuardStates, runDomainGuardFor } from '@/lib/seo/domain-guard'
import { seoError, seoGuard } from '@/lib/seo/http'

/**
 * The domain guard (src/lib/seo/domain-guard.ts): does each live client
 * site tell Google its own domain?
 *
 * GET  — every site's last state, by SEO site id.
 * POST { siteId } — look at that site now and take its next step (on the
 *        deployed Hub that can mean fixing its code and publishing it).
 * SEO allowlist only (Alex + Ethan): it can commit to client repos.
 */
export async function GET() {
  const guard = await seoGuard()
  if (guard instanceof NextResponse) return guard
  try {
    return NextResponse.json({ states: await domainGuardStates() })
  } catch (err) {
    return seoError(err, 'Domain guard')
  }
}

export async function POST(req: NextRequest) {
  const guard = await seoGuard()
  if (guard instanceof NextResponse) return guard
  try {
    const body = (await req.json().catch(() => ({}))) as { siteId?: unknown }
    const siteId = typeof body.siteId === 'string' ? body.siteId.trim() : ''
    if (!siteId) return NextResponse.json({ error: 'siteId is required.' }, { status: 400 })
    const state = await runDomainGuardFor(siteId)
    if (!state) return NextResponse.json({ error: 'That SEO site has no Site link to check.' }, { status: 404 })
    return NextResponse.json({ state })
  } catch (err) {
    return seoError(err, 'Domain guard')
  }
}
