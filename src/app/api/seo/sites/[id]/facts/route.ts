import { NextRequest, NextResponse } from 'next/server'
import { reseedFacts, resolveFactConflict } from '@/lib/seo/actions'
import { syncClientFacts } from '@/lib/seo/client-facts'
import { seoError, seoGuard } from '@/lib/seo/http'
import type { FactKey } from '@/lib/seo/types'
import { siteDetail } from '@/lib/seo/views'

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/seo/sites/[id]/facts
 *   {}                                         re-derive business facts from the intake and the site (~1 min)
 *   { action: 'sync_intake' }                  fold the client's newest onboarding answers in again
 *   { action: 'resolve', field, choice }       settle a form-vs-facts disagreement ('client' | 'current')
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const guard = await seoGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const body = (await req.json().catch(() => ({}))) as { action?: string; field?: string; choice?: string }
  try {
    if (body.action === 'sync_intake') await syncClientFacts(id, { force: true })
    else if (body.action === 'resolve') {
      if (!body.field || (body.choice !== 'client' && body.choice !== 'current')) {
        return NextResponse.json({ error: 'Say which field and which value to keep.' }, { status: 400 })
      }
      await resolveFactConflict(id, body.field as FactKey, body.choice, guard.email)
    } else await reseedFacts(id)
    return NextResponse.json({ site: await siteDetail(id) })
  } catch (err) {
    return seoError(err, 'business facts')
  }
}
