import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'
import { customizeAutoOn, setCustomizeAuto } from '@/lib/ghl-customize/queue'

/**
 * GET /api/admin/ghl-customize — whether the Hub customizes a client's GHL
 * lead workflows by itself when their site link is added, plus the recent
 * customize jobs.
 * POST { auto: boolean } — switch automatic runs on or off.
 */
async function state() {
  const jobs = await prisma.ghlCustomizeJob.findMany({
    orderBy: { updatedAt: 'desc' },
    take: 15,
    select: { id: true, clientId: true, status: true, detail: true, trigger: true, updatedAt: true, finishedAt: true, client: { select: { name: true } } },
  })
  return {
    auto: await customizeAutoOn(),
    jobs: jobs.map((j) => ({
      id: j.id,
      clientId: j.clientId,
      clientName: j.client.name,
      status: j.status,
      detail: j.detail,
      trigger: j.trigger,
      updatedAt: j.updatedAt.toISOString(),
      finishedAt: j.finishedAt?.toISOString() ?? null,
    })),
  }
}

export async function GET() {
  const denied = await requireAdmin()
  if (denied) return denied
  return NextResponse.json(await state())
}

export async function POST(req: Request) {
  const denied = await requireAdmin()
  if (denied) return denied
  const body = (await req.json().catch(() => null)) as { auto?: unknown } | null
  if (typeof body?.auto !== 'boolean') return NextResponse.json({ error: 'send { "auto": true } or { "auto": false }' }, { status: 400 })
  await setCustomizeAuto(body.auto)
  return NextResponse.json(await state())
}
