import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'
import { readTidyLog, tidyIntake } from '@/lib/intake-tidy'

/**
 * The onboarding-answer tidy (src/lib/intake-tidy.ts) for a client's latest submission. Admin only.
 * GET ?clientId=: what the last tidy changed, noted and left for a person.
 * POST { clientId, write? }: tidy it now. Without `write: true` it only says what would change. A client
 *   already on file keeps its name (only a client a submission just made is renamed).
 */
export const dynamic = 'force-dynamic'

const idOk = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9]{10,40}$/i.test(v)

async function latestIntake(clientId: string) {
  return prisma.clientIntake.findFirst({ where: { clientId }, orderBy: { receivedAt: 'desc' }, select: { id: true, receivedAt: true } })
}

export async function GET(req: Request) {
  const denied = await requireAdmin()
  if (denied) return denied
  const clientId = new URL(req.url).searchParams.get('clientId')
  if (!idOk(clientId)) return NextResponse.json({ error: 'clientId is required' }, { status: 400 })
  const intake = await latestIntake(clientId)
  if (!intake) return NextResponse.json({ error: 'That client has no onboarding submission.' }, { status: 404 })
  return NextResponse.json({ intakeId: intake.id, receivedAt: intake.receivedAt, log: await readTidyLog(intake.id) })
}

export async function POST(req: Request) {
  const denied = await requireAdmin()
  if (denied) return denied
  const body = (await req.json().catch(() => null)) as { clientId?: unknown; write?: unknown } | null
  if (!idOk(body?.clientId)) return NextResponse.json({ error: 'clientId is required' }, { status: 400 })
  const intake = await latestIntake(body.clientId)
  if (!intake) return NextResponse.json({ error: 'That client has no onboarding submission.' }, { status: 404 })
  const outcome = await tidyIntake(intake.id, { clientId: body.clientId, created: false, write: body.write === true })
  return NextResponse.json({ outcome })
}
