import { NextRequest, NextResponse } from 'next/server'
import { archiveSite, updateSite } from '@/lib/seo/actions'
import type { UpdateSiteBody } from '@/lib/seo/api-types'
import { seoError, seoGuard } from '@/lib/seo/http'
import { siteDetail, sitePosts, siteRuns } from '@/lib/seo/views'

type Ctx = { params: Promise<{ id: string }> }

/** GET /api/seo/sites/[id] — site, its runs and its post ledger. */
export async function GET(_req: NextRequest, { params }: Ctx) {
  const guard = await seoGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  try {
    const site = await siteDetail(id)
    if (!site) return NextResponse.json({ error: 'Site not found.' }, { status: 404 })
    const [runs, posts] = await Promise.all([siteRuns(id), sitePosts(id)])
    return NextResponse.json({ site, runs, posts })
  } catch (err) {
    return seoError(err, 'site detail')
  }
}

/** PATCH /api/seo/sites/[id] — settings, business facts, integrations. */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const guard = await seoGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  let body: UpdateSiteBody
  try {
    body = (await req.json()) as UpdateSiteBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  try {
    await updateSite(id, body, guard.email)
    return NextResponse.json({ site: await siteDetail(id) })
  } catch (err) {
    return seoError(err, 'update site')
  }
}

/** DELETE /api/seo/sites/[id] — archives (history is kept). */
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const guard = await seoGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  try {
    await archiveSite(id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return seoError(err, 'archive site')
  }
}
