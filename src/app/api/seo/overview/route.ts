import { NextResponse } from 'next/server'
import { seoError, seoGuard } from '@/lib/seo/http'
import { overview } from '@/lib/seo/views'

/** GET /api/seo/overview — the SEO dashboard: integrations, schedule, sites. Alex + Ethan only. */
export async function GET() {
  const guard = await seoGuard()
  if (guard instanceof NextResponse) return guard
  try {
    return NextResponse.json(await overview())
  } catch (err) {
    return seoError(err, 'overview')
  }
}
