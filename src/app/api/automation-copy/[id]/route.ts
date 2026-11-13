import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'
import { automationPrefill } from '@/lib/automation-copy'
import { AUTOMATION_COPY_PREFIX, cleanSavedCopy, parseSavedCopy } from '@/lib/automation-copy-saved'
import { boardInputs } from '@/lib/automation-copy-server'
import { syncProfileFromBoard } from '@/lib/hl/accounts'

/**
 * GET /api/automation-copy/:id — a client's Automation Copy board: what the
 * onboarding answers fill in, plus what staff typed or ticked.
 * PUT saves the board ({ values, done }), and carries the details it changed
 * into the client's Hell-level Business Profile (answers hellLevel: the
 * profile fields updated).
 */

const keyFor = (id: string) => `${AUTOMATION_COPY_PREFIX}${id}`

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied
  const { id } = await params
  const client = await prisma.client.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      contactName: true,
      contactEmail: true,
      contactPhone: true,
      siteUrl: true,
      website: true,
      intakes: {
        orderBy: { receivedAt: 'desc' },
        take: 1,
        select: { fullName: true, businessName: true, customerPhone: true, leadEmail: true, website: true, domainName: true },
      },
    },
  })
  if (!client) return NextResponse.json({ error: 'client not found' }, { status: 404 })
  const { intakes, ...c } = client
  const intake = intakes[0] ?? null
  const row = await prisma.appSetting.findUnique({ where: { key: keyFor(id) } })
  return NextResponse.json({
    client: { id: c.id, name: c.name, siteUrl: c.siteUrl, hasIntake: !!intake },
    prefill: automationPrefill({ ...c, intake }),
    saved: parseSavedCopy(row?.value),
  })
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied
  const { id } = await params
  let body: { values?: unknown; done?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const exists = await prisma.client.findUnique({ where: { id }, select: { id: true } })
  if (!exists) return NextResponse.json({ error: 'client not found' }, { status: 404 })
  const before = await boardInputs(id)
  const saved = cleanSavedCopy({ ...body, updatedAt: new Date().toISOString() })
  const value = JSON.stringify(saved)
  await prisma.appSetting.upsert({ where: { key: keyFor(id) }, create: { key: keyFor(id), value }, update: { value } })
  // What this save changed also goes into their Hell-level Business Profile, which the texts read.
  const hellLevel = await syncProfileFromBoard(id, before, await boardInputs(id)).catch((err) => {
    console.warn(`[automation-copy] hell-level profile for ${id}:`, err instanceof Error ? err.message : err)
    return [] as string[]
  })
  return NextResponse.json({ saved, hellLevel })
}
