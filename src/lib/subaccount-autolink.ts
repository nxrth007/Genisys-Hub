/**
 * Sub-account auto-link scan: list CRM locations -> score them against
 * clients with no sub-account -> link clear winners via linkGhlSubAccount
 * (which also advances the journey). Idempotent: linked clients and
 * locations drop out of the next scan; needs-review pairs are stored in
 * SubaccountMatchSuggestion and only logged to the journey when new or
 * their score changes; rejected pairs are never suggested again.
 */
import { prisma } from './prisma'
import { getCrmProvider } from './crm/provider'
import { matchSubaccounts, type MatchClient, type MatchResult } from './crm/subaccount-match'
import { linkGhlSubAccount } from './ghl-subaccount-provisioning'

const ACTOR = 'subaccount-autolink'

export type ScanReport = {
  dryRun: boolean
  truncated: boolean
  proposed: MatchResult['autoLinks']
  needsReview: MatchResult['needsReview']
  linked: { clientId: string; locationId: string; score: number }[]
  failed: { clientId: string; locationId: string; reason: string }[]
  skipped: MatchResult['skipped']
}

async function logJourney(clientId: string, note: string) {
  const row = await prisma.clientJourneyStage.findUnique({ where: { clientId_stage: { clientId, stage: 'subaccount' } } })
  const status = row?.status ?? 'pending'
  await prisma.clientJourneyEvent.create({
    data: { clientId, stage: 'subaccount', fromStatus: status, toStatus: status, note: note.slice(0, 2000), actor: ACTOR },
  })
}

export async function rejectSubaccountMatch(clientId: string, locationId: string, locationName = '') {
  await prisma.subaccountMatchSuggestion.upsert({
    where: { clientId_locationId: { clientId, locationId } },
    create: { clientId, locationId, locationName, score: 0, reasons: [], status: 'rejected' },
    update: { status: 'rejected' },
  })
}

export async function scanSubaccounts(opts: { dryRun?: boolean; actor?: string | null } = {}): Promise<ScanReport> {
  const dryRun = opts.dryRun === true
  const { locations, truncated } = await getCrmProvider().listLocations()
  const rows = await prisma.client.findMany({
    select: {
      id: true, name: true, ghlLocationId: true, contactName: true, contactPhone: true, contactEmail: true,
      intakes: { orderBy: { receivedAt: 'desc' }, take: 1, select: { fullName: true, businessName: true, customerPhone: true, leadEmail: true } },
    },
  })
  const clients: MatchClient[] = rows.map((c) => {
    const i = c.intakes[0]
    return {
      id: c.id, name: c.name, ghlLocationId: c.ghlLocationId, contactName: c.contactName,
      intakeName: i?.fullName ?? null, intakeBusiness: i?.businessName ?? null,
      phones: [c.contactPhone, i?.customerPhone], emails: [c.contactEmail, i?.leadEmail],
    }
  })
  const stored = await prisma.subaccountMatchSuggestion.findMany({ select: { clientId: true, locationId: true, status: true, score: true } })
  const rejected = stored.filter((s) => s.status === 'rejected').map((s) => `${s.clientId}:${s.locationId}`)
  const result = matchSubaccounts(clients, locations, { rejected })
  const report: ScanReport = { dryRun, truncated, proposed: result.autoLinks, needsReview: result.needsReview, linked: [], failed: [], skipped: result.skipped }
  if (dryRun) return report

  for (const r of result.needsReview) {
    const prev = stored.find((s) => s.clientId === r.clientId && s.locationId === r.locationId)
    await prisma.subaccountMatchSuggestion.upsert({
      where: { clientId_locationId: { clientId: r.clientId, locationId: r.locationId } },
      create: { clientId: r.clientId, locationId: r.locationId, locationName: r.locationName, score: r.score, reasons: r.reasons, status: 'needs_review' },
      update: { locationName: r.locationName, score: r.score, reasons: r.reasons },
    })
    if (!prev || prev.score !== r.score) {
      await logJourney(r.clientId, `Sub-account scan: “${r.locationName}” (${r.locationId}) needs review, score ${r.score} (${r.why}): ${r.reasons.join(', ')}`)
    }
  }

  for (const a of result.autoLinks) {
    const res = await linkGhlSubAccount(a.clientId, { locationId: a.locationId, actor: opts.actor ?? ACTOR })
    if (res.ok && res.status === 'linked') {
      report.linked.push({ clientId: a.clientId, locationId: a.locationId, score: a.score })
      await logJourney(a.clientId, `Sub-account scan auto-linked “${a.locationName}” (${a.locationId}), score ${a.score}: ${a.reasons.join(', ')}`)
      await prisma.subaccountMatchSuggestion.deleteMany({ where: { clientId: a.clientId, status: 'needs_review' } })
    } else if (!res.ok) {
      report.failed.push({ clientId: a.clientId, locationId: a.locationId, reason: res.reason ?? res.status })
    }
  }
  return report
}
