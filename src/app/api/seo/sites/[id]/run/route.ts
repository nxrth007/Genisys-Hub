import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { startRun } from '@/lib/seo/actions'
import { kickEngine, seoError, seoGuard } from '@/lib/seo/http'
import { runSummary } from '@/lib/seo/views'

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/seo/sites/[id]/run { kind: 'weekly' | 'foundation' }
 *
 * Queues the run and nudges the engine; the work itself happens in the
 * engine's worker, never inside this request.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const guard = await seoGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  let kind: 'weekly' | 'foundation' = 'weekly'
  try {
    const body = (await req.json().catch(() => ({}))) as { kind?: string }
    if (body.kind === 'foundation') kind = 'foundation'
  } catch {
    /* default weekly */
  }
  try {
    const runId = await startRun(id, kind)
    kickEngine()
    const run = await prisma.seoRun.findUniqueOrThrow({ where: { id: runId } })
    return NextResponse.json({ run: runSummary(run) }, { status: 201 })
  } catch (err) {
    return seoError(err, 'start run')
  }
}
