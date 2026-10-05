import { NextRequest, NextResponse } from 'next/server'
import { publishSiteNow } from '@/lib/seo/actions'
import { seoError, seoGuard } from '@/lib/seo/http'

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/seo/sites/[id]/publish — publish the site in Lovable now,
 * through the Hub's Lovable connection. Waits for Lovable (up to a couple
 * of minutes) so the person sees whether it went through.
 */
export async function POST(_req: NextRequest, { params }: Ctx) {
  const guard = await seoGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  try {
    return NextResponse.json(await publishSiteNow(id, guard.email))
  } catch (err) {
    return seoError(err, 'publish site')
  }
}
