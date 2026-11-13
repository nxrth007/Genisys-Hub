import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-helpers'
import { previewReviewLinks, saveReviewLinks } from '@/lib/hl/review-links'

/**
 * Client sub-accounts' Google review links (src/lib/hl/review-links.ts).
 * GET: what would be filled in, and why, for each sub-account without one
 * (one Google Maps search each; nothing is saved).
 * POST { links: [{ clientId, link }] }: save the checked ones, only where
 * the sub-account still has none.
 */

export const maxDuration = 300

export async function GET() {
  const denied = await requireAdmin()
  if (denied) return denied
  const rows = await previewReviewLinks()
  return NextResponse.json({ rows })
}

export async function POST(req: Request) {
  const denied = await requireAdmin()
  if (denied) return denied
  const body = (await req.json().catch(() => null)) as { links?: unknown } | null
  const links = Array.isArray(body?.links)
    ? body.links.flatMap((l) => {
        const x = (l ?? {}) as { clientId?: unknown; link?: unknown }
        return typeof x.clientId === 'string' && typeof x.link === 'string' && /^https:\/\/\S+$/i.test(x.link.trim()) ? [{ clientId: x.clientId, link: x.link.trim() }] : []
      })
    : []
  if (!links.length) return NextResponse.json({ error: 'Send links: [{ clientId, link }].' }, { status: 400 })
  return NextResponse.json({ results: await saveReviewLinks(links) })
}
