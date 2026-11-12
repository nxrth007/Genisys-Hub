import { prisma } from '@/lib/prisma'
import { AUTOMATION_IDS, type AutomationInputs, automationPrefill, bestIntake } from '@/lib/automation-copy'
import { AUTOMATION_COPY_PREFIX, cleanSavedCopy, parseSavedCopy, type SavedCopy } from '@/lib/automation-copy-saved'
import { markTrackerStep } from '@/lib/onboarding-tracker'

/**
 * A client's Automation Copy details as the board shows them: the onboarding
 * prefill, then what staff saved, then (optionally) values sent with a request.
 * Null when the client doesn't exist.
 */
export async function boardInputs(id: string, override?: unknown): Promise<AutomationInputs | null> {
  const client = await prisma.client.findUnique({
    where: { id },
    select: {
      name: true,
      contactName: true,
      contactEmail: true,
      contactPhone: true,
      siteUrl: true,
      website: true,
      intakes: {
        orderBy: { receivedAt: 'desc' },
        take: 6,
        select: { fullName: true, businessName: true, businessAddress: true, customerPhone: true, leadEmail: true, website: true, domainName: true },
      },
    },
  })
  if (!client) return null
  const { intakes, ...c } = client
  const row = await prisma.appSetting.findUnique({ where: { key: `${AUTOMATION_COPY_PREFIX}${id}` } })
  const saved = parseSavedCopy(row?.value).values
  const fromBody = override ? cleanSavedCopy({ values: override }).values : {}
  return { ...automationPrefill({ ...c, intake: bestIntake(intakes) ?? null }), ...saved, ...fromBody }
}

/** Every automation on the client's board is ticked as set up. */
export async function automationCopyDone(id: string): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key: `${AUTOMATION_COPY_PREFIX}${id}` } })
  const done = new Set(parseSavedCopy(row?.value).done)
  return AUTOMATION_IDS.every((a) => done.has(a))
}

/**
 * "Mark Completed": tick every automation on the client's board as set up,
 * and check "Automations Configuration" for them in Ethan's onboarding
 * tracker sheet. Null when the client doesn't exist.
 */
export async function markAutomationCopyDone(id: string): Promise<{ saved: SavedCopy; tracker: Awaited<ReturnType<typeof markTrackerStep>> } | null> {
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
  return { saved, tracker }
}
