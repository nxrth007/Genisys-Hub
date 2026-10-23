import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'
import { AUTOMATION_IDS } from '@/lib/automation-copy'
import { AUTOMATION_COPY_PREFIX, cleanSavedCopy, parseSavedCopy } from '@/lib/automation-copy-saved'
import { markTrackerStep, trackerRowFor } from '@/lib/onboarding-tracker'

/**
 * POST /api/automation-copy/:id/complete — "Mark Completed": every automation
 * on the board is ticked as set up in GHL, and the client's "Automations
 * Configuration" box in Ethan's onboarding tracker sheet is checked.
 */
async function who(id: string) {
  const client = await prisma.client.findUnique({
    where: { id },
    select: {
      name: true,
      contactName: true,
      contactEmail: true,
      intakes: { orderBy: { receivedAt: 'desc' }, take: 1, select: { leadEmail: true, fullName: true, businessName: true } },
    },
  })
  if (!client) return null
  const intake = client.intakes[0]
  return {
    emails: [intake?.leadEmail, client.contactEmail],
    business: intake?.businessName || client.name,
    name: intake?.fullName || client.contactName,
  }
}

/** GET — this client's row in the onboarding tracker (read-only). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied
  const { id } = await params
  const w = await who(id)
  if (!w) return NextResponse.json({ error: 'client not found' }, { status: 404 })
  return NextResponse.json(await trackerRowFor(w))
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied
  const { id } = await params
  const client = await prisma.client.findUnique({
    where: { id },
    select: {
      name: true,
      contactName: true,
      contactEmail: true,
      intakes: { orderBy: { receivedAt: 'desc' }, take: 1, select: { leadEmail: true, fullName: true, businessName: true } },
    },
  })
  if (!client) return NextResponse.json({ error: 'client not found' }, { status: 404 })

  const key = `${AUTOMATION_COPY_PREFIX}${id}`
  const row = await prisma.appSetting.findUnique({ where: { key } })
  const saved = cleanSavedCopy({ ...parseSavedCopy(row?.value), done: AUTOMATION_IDS, updatedAt: new Date().toISOString() })
  await prisma.appSetting.upsert({ where: { key }, create: { key, value: JSON.stringify(saved) }, update: { value: JSON.stringify(saved) } })

  const intake = client.intakes[0]
  const tracker = await markTrackerStep('automations', {
    emails: [intake?.leadEmail, client.contactEmail],
    business: intake?.businessName || client.name,
    name: intake?.fullName || client.contactName,
  })
  return NextResponse.json({ saved, tracker })
}
