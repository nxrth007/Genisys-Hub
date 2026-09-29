import { NextRequest, NextResponse } from 'next/server'
import { createSite } from '@/lib/seo/actions'
import type { CreateSiteBody } from '@/lib/seo/api-types'
import { seoError, seoGuard } from '@/lib/seo/http'
import { siteDetail } from '@/lib/seo/views'

/** POST /api/seo/sites — add a client site to the SEO engine. */
export async function POST(req: NextRequest) {
  const guard = await seoGuard()
  if (guard instanceof NextResponse) return guard
  let body: CreateSiteBody
  try {
    body = (await req.json()) as CreateSiteBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  try {
    const id = await createSite(body)
    return NextResponse.json({ site: await siteDetail(id) }, { status: 201 })
  } catch (err) {
    return seoError(err, 'create site')
  }
}
