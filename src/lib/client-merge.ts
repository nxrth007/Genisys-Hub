import type { Prisma } from '@/generated/prisma/client'
import { prisma } from './prisma'
import { archiveSite } from './seo/actions'

export type MergeResult = { keptId: string; name: string; moved: Record<string, number>; notes: string[] }

/** Fields copied from the merged-away client when the kept one has none. */
const FILL_FIELDS = [
  'state',
  'siteUrl',
  'siteLiveAt',
  'contactName',
  'contactRole',
  'contactEmail',
  'contactPhone',
  'address',
  'intakeFormUrl',
  'ghlSubaccountUrl',
  'servicingZipcodes',
  'appointmentTypes',
  'bookWeekends',
  'website',
  'providesBatteryBackup',
  'qualificationCriteria',
  'onboardingNotes',
  'apptCap',
  'dueDate',
  'serviceStartDate',
  'invoicingCutoffAt',
  'lastInvoicedAt',
] as const

/**
 * Fields that only make sense together, keyed by the one that says the
 * group is set: taken whole when the kept client lacks it and the other has it.
 */
const GROUPS: [string, string[]][] = [
  ['ghlLocationId', ['ghlLocationId', 'ghlProvisionStatus', 'ghlProvisionError', 'ghlProvisionedAt', 'ghlSnapshotStatus', 'leadAlertInstallStatus', 'leadAlertInstallError', 'leadAlertInstallAt', 'leadAlertSnapshotId']],
  ['slackChannelId', ['slackChannelId', 'slackChannelName', 'slackInviteSentAt']],
  ['geoLat', ['geoLat', 'geoLng', 'geoLabel', 'geoStatus', 'geoRetryAt', 'geocodedAt']],
]

/** Further along wins when the two disagree. */
const LIFECYCLE_RANK: Record<string, number> = { active: 4, paused: 3, onboarding: 2, pending: 1, churned: 0, denied: 0 }

/**
 * Fold `dropId` into `keepId`: every record pointing at the duplicate moves
 * to the kept client, empty details are filled from it, then it's deleted.
 * `useOtherName` gives the kept client the duplicate's name.
 */
export async function mergeClients(keepId: string, dropId: string, opts: { useOtherName?: boolean } = {}): Promise<MergeResult> {
  if (keepId === dropId) throw new Error('Pick two different clients.')
  const [keep, drop] = await Promise.all([
    prisma.client.findUnique({ where: { id: keepId }, include: { seoSite: true } }),
    prisma.client.findUnique({ where: { id: dropId }, include: { seoSite: true } }),
  ])
  if (!keep || !drop) throw new Error('One of those clients no longer exists.')

  const notes: string[] = []

  // Which SEO site survives: the kept client's, unless only the other one has a repo.
  const sites = { keep: keep.seoSite, drop: drop.seoSite }
  const siteToKeep = sites.keep && sites.drop ? (sites.drop.repoFullName && !sites.keep.repoFullName ? sites.drop : sites.keep) : (sites.keep ?? sites.drop)
  const siteToArchive = sites.keep && sites.drop ? (siteToKeep === sites.keep ? sites.drop : sites.keep) : null
  if (siteToArchive && !siteToArchive.archivedAt) {
    // Cancels its runs and closes its PRs before it's detached.
    await archiveSite(siteToArchive.id)
    notes.push(`The second SEO site (${siteToArchive.repoFullName ?? 'no repo'}) was archived; ${siteToKeep?.repoFullName ?? 'the other one'} stays.`)
  }

  if (keep.ghlLocationId && drop.ghlLocationId && keep.ghlLocationId !== drop.ghlLocationId) {
    notes.push(`${drop.name} had its own GHL sub-account (location ${drop.ghlLocationId}). The merged client keeps ${keep.ghlLocationId}; delete the other one in GHL if it's a spare.`)
  }
  if (keep.slackChannelId && drop.slackChannelId && keep.slackChannelId !== drop.slackChannelId) {
    notes.push(`${drop.name} had its own Slack channel (#${drop.slackChannelName ?? drop.slackChannelId}); archive it in Slack if it's a spare.`)
  }

  const name = opts.useOtherName ? drop.name : keep.name
  const moved: Record<string, number> = {}

  await prisma.$transaction(async (tx) => {
    const move = async (label: string, fn: () => Promise<{ count: number }>) => {
      const { count } = await fn()
      if (count) moved[label] = count
    }
    const w = { where: { clientId: dropId }, data: { clientId: keepId } }
    await move('onboarding submissions', () => tx.clientIntake.updateMany(w))
    await move('logins', () => tx.user.updateMany(w))
    await move('invoices', () => tx.invoice.updateMany(w))
    await move('appointments', () => tx.appointment.updateMany(w))
    await move('appointment reminders', () => tx.appointmentReminder.updateMany(w))
    await move('Slack deliveries', () => tx.sheetSlackDelivery.updateMany(w))
    await move('SMS alerts', () => tx.clientAlertDelivery.updateMany(w))
    await move('email alerts', () => tx.clientEmailDelivery.updateMany(w))
    await move('message alerts', () => tx.clientMessageAlert.updateMany(w))
    await move('dialer lists', () => tx.vicidialListLink.updateMany(w))
    await move('secondary sheets', () => tx.secondarySheet.updateMany(w))
    await move('appointment edits', () => tx.appointmentEditLog.updateMany(w))
    // One template per client and type: the kept client's wins.
    const keptTypes = (await tx.reminderTemplate.findMany({ where: { clientId: keepId }, select: { reminderType: true } })).map((t) => t.reminderType)
    await tx.reminderTemplate.deleteMany({ where: { clientId: dropId, reminderType: { in: keptTypes } } })
    await move('reminder templates', () => tx.reminderTemplate.updateMany(w))

    if (siteToArchive) await tx.seoSite.update({ where: { id: siteToArchive.id }, data: { clientId: null, archivedAt: siteToArchive.archivedAt ?? new Date(), enabled: false } })
    if (siteToKeep && siteToKeep.clientId !== keepId) {
      await tx.seoSite.update({ where: { id: siteToKeep.id }, data: { clientId: keepId } })
      moved['SEO site'] = 1
    }
    if (siteToKeep) await tx.seoSite.update({ where: { id: siteToKeep.id }, data: { name } })

    const a2p = await tx.appSetting.findMany({ where: { key: { in: [`a2p.client.${keepId}`, `a2p.client.${dropId}`] } } })
    if (a2p.length === 1 && a2p[0].key.endsWith(dropId)) {
      await tx.appSetting.update({ where: { id: a2p[0].id }, data: { key: `a2p.client.${keepId}` } })
      moved['A2P board'] = 1
    } else if (a2p.length === 2) {
      await tx.appSetting.deleteMany({ where: { key: `a2p.client.${dropId}` } })
    }

    const k = keep as unknown as Record<string, unknown>
    const d = drop as unknown as Record<string, unknown>
    const empty = (v: unknown) => v === null || v === undefined || v === ''
    const data: Record<string, unknown> = { name }
    for (const f of FILL_FIELDS) if (empty(k[f]) && !empty(d[f])) data[f] = d[f]
    for (const [lead, fields] of GROUPS) if (empty(k[lead]) && !empty(d[lead])) for (const f of fields) data[f] = d[f]
    if (keep.notes && drop.notes && keep.notes.trim() !== drop.notes.trim()) data.notes = `${keep.notes.trim()}\n\n— From ${drop.name}:\n${drop.notes.trim()}`
    else if (!keep.notes && drop.notes) data.notes = drop.notes
    if ((LIFECYCLE_RANK[drop.lifecycle] ?? 0) > (LIFECYCLE_RANK[keep.lifecycle] ?? 0)) data.lifecycle = drop.lifecycle
    if (drop.active && !keep.active) data.active = true
    if (drop.emailAlertsEnabled && !keep.emailAlertsEnabled) data.emailAlertsEnabled = true
    // The relationship started with whichever came first.
    if (drop.createdAt < keep.createdAt) data.createdAt = drop.createdAt
    if (keep.archivedAt && !drop.archivedAt) data.archivedAt = null

    // Deleted first: its name and GHL location are unique and may be what the kept client takes.
    await tx.client.delete({ where: { id: dropId } })
    await tx.client.update({ where: { id: keepId }, data: data as Prisma.ClientUpdateInput })
  })

  return { keptId: keepId, name, moved, notes }
}
