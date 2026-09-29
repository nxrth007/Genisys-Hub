import { NextRequest, NextResponse } from 'next/server'
import { reseedFacts } from '@/lib/seo/actions'
import { seoError, seoGuard } from '@/lib/seo/http'
import { siteDetail } from '@/lib/seo/views'

type Ctx = { params: Promise<{ id: string }> }

/** POST /api/seo/sites/[id]/facts — re-derive business facts from the intake and the site (~1 min). */
export async function POST(_req: NextRequest, { params }: Ctx) {
  const guard = await seoGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  try {
    await reseedFacts(id)
    return NextResponse.json({ site: await siteDetail(id) })
  } catch (err) {
    return seoError(err, 'reseed facts')
  }
}
