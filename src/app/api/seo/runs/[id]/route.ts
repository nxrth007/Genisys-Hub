import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { runAction } from '@/lib/seo/actions'
import type { RunActionBody } from '@/lib/seo/api-types'
import { kickEngine, seoError, seoGuard } from '@/lib/seo/http'
import { runDetail, runSummary } from '@/lib/seo/views'

type Ctx = { params: Promise<{ id: string }> }

/** GET /api/seo/runs/[id] — everything about one run. */
export async function GET(_req: NextRequest, { params }: Ctx) {
  const guard = await seoGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  try {
    const run = await runDetail(id)
    if (!run) return NextResponse.json({ error: 'Run not found.' }, { status: 404 })
    return NextResponse.json({ run })
  } catch (err) {
    return seoError(err, 'run detail')
  }
}

/** POST /api/seo/runs/[id] — approve | reject | mark_published | cancel | retry. */
export async function POST(req: NextRequest, { params }: Ctx) {
  const guard = await seoGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  let body: RunActionBody
  try {
    body = (await req.json()) as RunActionBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  try {
    await runAction(id, body, guard.email)
    if (body.action === 'approve' || body.action === 'mark_published' || body.action === 'retry') kickEngine()
    const run = await prisma.seoRun.findUniqueOrThrow({ where: { id } })
    return NextResponse.json({ run: runSummary(run) })
  } catch (err) {
    return seoError(err, `run action ${body.action}`)
  }
}
