import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { requireAdmin } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'
import { getJourney, getJourneyEvents, isJourneyStage, isJourneyStatus, setJourneyStage } from '@/lib/client-journey'

/**
 * Fulfillment journey for one client (src/lib/client-journey.ts).
 *
 *   GET  ?clientId=…                       → stages + recent audit events
 *   POST { clientId, stage, status, note? } → set a stage by hand (audited)
 *
 * Admin only, like every /api/admin route.
 */
export async function GET(req: Request) {
  const denial = await requireAdmin()
  if (denial) return denial
  const clientId = new URL(req.url).searchParams.get('clientId')
  if (!clientId) return NextResponse.json({ error: 'clientId is required' }, { status: 400 })
  const exists = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true } })
  if (!exists) return NextResponse.json({ error: 'client not found' }, { status: 404 })
  return NextResponse.json({ journey: await getJourney(clientId), events: await getJourneyEvents(clientId) })
}

export async function POST(req: Request) {
  const denial = await requireAdmin()
  if (denial) return denial
  const body = (await req.json().catch(() => null)) as { clientId?: unknown; stage?: unknown; status?: unknown; note?: unknown } | null
  if (!body || typeof body.clientId !== 'string' || !body.clientId) return NextResponse.json({ error: 'clientId is required' }, { status: 400 })
  if (!isJourneyStage(body.stage)) return NextResponse.json({ error: 'invalid stage' }, { status: 400 })
  if (!isJourneyStatus(body.status)) return NextResponse.json({ error: 'invalid status' }, { status: 400 })
  const exists = await prisma.client.findUnique({ where: { id: body.clientId }, select: { id: true } })
  if (!exists) return NextResponse.json({ error: 'client not found' }, { status: 404 })
  const session = await auth()
  await setJourneyStage(body.clientId, body.stage, body.status, {
    note: typeof body.note === 'string' ? body.note : undefined,
    actor: session?.user?.id ?? null,
  })
  return NextResponse.json({ journey: await getJourney(body.clientId) })
}
