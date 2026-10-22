import { prisma } from '@/lib/prisma'
import { automationPrefill, type AutomationInputs } from '@/lib/automation-copy'
import { AUTOMATION_COPY_PREFIX, cleanSavedCopy, parseSavedCopy } from '@/lib/automation-copy-saved'

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
        take: 1,
        select: { fullName: true, businessName: true, customerPhone: true, leadEmail: true, website: true, domainName: true },
      },
    },
  })
  if (!client) return null
  const { intakes, ...c } = client
  const row = await prisma.appSetting.findUnique({ where: { key: `${AUTOMATION_COPY_PREFIX}${id}` } })
  const saved = parseSavedCopy(row?.value).values
  const fromBody = override ? cleanSavedCopy({ values: override }).values : {}
  return { ...automationPrefill({ ...c, intake: intakes[0] ?? null }), ...saved, ...fromBody }
}
