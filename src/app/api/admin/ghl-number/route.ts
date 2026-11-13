import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'
import { bankLocationId, numberAskOn, setNumberAsk } from '@/lib/ghl-number/queue'

/**
 * GET /api/admin/ghl-number — whether Atlas asks in the Office for a toll-free
 * number when a new sub-account is ready, which sub-account is the number
 * bank, and the recent number jobs.
 * POST { ask: boolean } — switch the asking on or off.
 */
async function state() {
  const jobs = await prisma.ghlNumberJob.findMany({
    orderBy: { updatedAt: 'desc' },
    take: 15,
    select: { id: true, clientId: true, status: true, detail: true, phoneNumber: true, trigger: true, updatedAt: true, finishedAt: true, client: { select: { name: true } } },
  })
  return {
    ask: await numberAskOn(),
    bankLocationId: await bankLocationId(),
    jobs: jobs.map((j) => ({
      id: j.id,
      clientId: j.clientId,
      clientName: j.client.name,
      status: j.status,
      detail: j.detail,
      phoneNumber: j.phoneNumber,
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
  const body = (await req.json().catch(() => null)) as { ask?: unknown } | null
  if (typeof body?.ask !== 'boolean') return NextResponse.json({ error: 'send { "ask": true } or { "ask": false }' }, { status: 400 })
  await setNumberAsk(body.ask)
  return NextResponse.json(await state())
}
