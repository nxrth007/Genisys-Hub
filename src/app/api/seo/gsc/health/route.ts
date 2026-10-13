import { NextResponse } from 'next/server'
import { checkGscHealth, lastGscHealth } from '@/lib/seo/gsc-health'
import { seoError, seoGuard } from '@/lib/seo/http'

/**
 * GET /api/seo/gsc/health — the last Search Console health check.
 * POST — run it now (read-only against Google).
 */
export async function GET() {
  const guard = await seoGuard()
  if (guard instanceof NextResponse) return guard
  try {
    return NextResponse.json({ health: await lastGscHealth() })
  } catch (err) {
    return seoError(err, 'Search Console health')
  }
}

export async function POST() {
  const guard = await seoGuard()
  if (guard instanceof NextResponse) return guard
  try {
    return NextResponse.json({ health: await checkGscHealth() })
  } catch (err) {
    return seoError(err, 'Search Console health check')
  }
}
