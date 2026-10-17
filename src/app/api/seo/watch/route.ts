import { NextResponse } from 'next/server'
import { lastSeoWatch, runSeoWatch } from '@/lib/seo/site-watch'
import { seoError, seoGuard } from '@/lib/seo/http'

/**
 * GET /api/seo/watch — the last daily site check.
 * POST — run it now without posting to Slack (read-only against the sites and Google).
 */
export async function GET() {
  const guard = await seoGuard()
  if (guard instanceof NextResponse) return guard
  try {
    return NextResponse.json({ watch: await lastSeoWatch() })
  } catch (err) {
    return seoError(err, 'SEO site check')
  }
}

export async function POST() {
  const guard = await seoGuard()
  if (guard instanceof NextResponse) return guard
  try {
    return NextResponse.json({ watch: await runSeoWatch({ alert: false }) })
  } catch (err) {
    return seoError(err, 'SEO site check')
  }
}
