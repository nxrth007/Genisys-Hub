/**
 * Puts the "Lead alert → Hub" workflow into No EIN clients' sub-accounts
 * without anyone opening GHL: the workflow lives in a small snapshot
 * (chosen once in Settings), and the Hub loads that snapshot into the
 * sub-account through the agency key as soon as a client is No EIN. A
 * sub-account made by hand is linked first, from the card's link or by
 * name. Loading never overrides what the sub-account already has.
 *
 * Runs from the client PATCH (EIN status or sub-account link changed)
 * and from a 5-minute sweep, which also catches sub-accounts that appear
 * later, a newly chosen snapshot, and retries failures every few hours.
 */
import { prisma } from '@/lib/prisma'
import { getAgencyContext, getSnapshotPushStatus, loadSnapshotIntoLocation, GhlAgencyError } from '@/lib/ghl-agency'
import { hubAlertThrottled, hubLink } from '@/lib/hub-alerts'
import { linkGhlSubAccount, parseLocationId } from '@/lib/ghl-subaccount-provisioning'

const IN_FLIGHT_MS = 10 * 60_000
const FAILED_RETRY_MS = 6 * 60 * 60_000
const FOLLOW_UP_MS = 3 * 60_000

export type InstallResult = { status: 'installed' | 'installing' | 'failed' | 'skipped'; reason?: string }

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Finding a sub-account by name lists the whole agency, so a client that
// isn't found is only looked for again after a while.
const LINK_RETRY_MS = 60 * 60_000
const lastLinkAttempt = new Map<string, number>()

/**
 * Sub-accounts made by hand never got their id stored. Link one from the
 * card's GHL sub-account link, or by the "First name: Business" name.
 */
async function findSubAccount(
  clientId: string,
  url: string | null,
  force: boolean,
): Promise<{ ok: true; locationId: string } | { ok: false; reason: string; throttled?: boolean }> {
  const last = lastLinkAttempt.get(clientId) ?? 0
  if (!force && Date.now() - last < LINK_RETRY_MS) {
    return { ok: false, reason: 'No GHL sub-account found for this client yet.', throttled: true }
  }
  lastLinkAttempt.set(clientId, Date.now())
  const fromUrl = url ? parseLocationId(url) : null
  const r = await linkGhlSubAccount(clientId, fromUrl ? { locationId: fromUrl } : {})
  if (r.ok) return { ok: true, locationId: r.locationId }
  return {
    ok: false,
    reason: fromUrl
      ? r.reason
      : `${r.reason} Or paste the sub-account's link into the client card's GHL sub-account field.`,
  }
}

/**
 * `force` loads it again even when it's installed; `relink` looks for the
 * sub-account straight away (the card's link just changed).
 */
export async function installLeadAlertWorkflow(
  clientId: string,
  opts: { force?: boolean; relink?: boolean } = {},
): Promise<InstallResult> {
  const [client, config] = await Promise.all([
    prisma.client.findUnique({
      where: { id: clientId },
      select: {
        name: true,
        einStatus: true,
        active: true,
        ghlLocationId: true,
        ghlSubaccountUrl: true,
        leadAlertInstallStatus: true,
        leadAlertInstallAt: true,
        leadAlertSnapshotId: true,
      },
    }),
    prisma.clientAlertsConfig.upsert({ where: { id: 'singleton' }, create: {}, update: {} }),
  ])
  if (!client) return { status: 'skipped', reason: 'Client not found.' }
  if (client.einStatus !== 'none') return { status: 'skipped', reason: 'Client isn’t marked No EIN.' }
  if (!client.active) return { status: 'skipped', reason: 'Client is inactive.' }
  const snapshotId = config.leadAlertSnapshotId
  if (!snapshotId) return { status: 'skipped', reason: 'No lead-alert snapshot is chosen in Settings yet.' }
  if (!client.ghlLocationId) {
    const linked = await findSubAccount(clientId, client.ghlSubaccountUrl, !!(opts.force || opts.relink))
    if (!linked.ok) {
      if (!linked.throttled) {
        await prisma.client.update({ where: { id: clientId }, data: { leadAlertInstallError: linked.reason.slice(0, 2000) } })
      }
      return { status: 'skipped', reason: linked.reason }
    }
    client.ghlLocationId = linked.locationId
  }

  const current = client.leadAlertSnapshotId === snapshotId ? client.leadAlertInstallStatus : null
  const since = client.leadAlertInstallAt ? Date.now() - client.leadAlertInstallAt.getTime() : Infinity
  if (current === 'installing' && since < IN_FLIGHT_MS) return { status: 'installing' }
  if (!opts.force) {
    if (current === 'installed') return { status: 'installed' }
    if (current === 'failed' && since < FAILED_RETRY_MS) return { status: 'failed', reason: 'Waiting to retry.' }
  }

  // Claimed on the row so the PATCH and the sweep can't both load it.
  const claimed = await prisma.client.updateMany({
    where: {
      id: clientId,
      OR: [
        { leadAlertInstallStatus: { not: 'installing' } },
        { leadAlertInstallStatus: null },
        { leadAlertInstallAt: { lt: new Date(Date.now() - IN_FLIGHT_MS) } },
      ],
    },
    data: { leadAlertInstallStatus: 'installing', leadAlertInstallAt: new Date(), leadAlertSnapshotId: snapshotId, leadAlertInstallError: null },
  })
  if (claimed.count === 0) return { status: 'installing' }

  try {
    const ctx = await getAgencyContext()
    await loadSnapshotIntoLocation(ctx, client.ghlLocationId, snapshotId)
  } catch (err) {
    const reason = describe(err)
    await prisma.client.update({
      where: { id: clientId },
      data: { leadAlertInstallStatus: 'failed', leadAlertInstallError: reason.slice(0, 2000) },
    })
    await hubAlertThrottled(
      `lead-alert-install:${clientId}`,
      FAILED_RETRY_MS,
      `:warning: *Couldn't install lead texts for ${client.name}* — loading the lead-alert snapshot into their sub-account failed: ${reason}${err instanceof GhlAgencyError && err.status !== null && err.status < 500 ? '' : ' The Hub will try again.'} <${hubLink('/settings/client-alerts')}|Client SMS → Lead texts>`,
    )
    return { status: 'failed', reason }
  }

  await prisma.client.update({ where: { id: clientId }, data: { leadAlertInstallStatus: 'installed' } })
  setTimeout(() => {
    void checkLoad(clientId).catch((err) => console.warn(`[lead-alert-install] follow-up for ${clientId}:`, describe(err)))
  }, FOLLOW_UP_MS).unref?.()
  return { status: 'installed' }
}

/** GHL accepts the load before running it; catch a load that then fails. */
async function checkLoad(clientId: string): Promise<void> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { name: true, ghlLocationId: true, leadAlertSnapshotId: true, leadAlertInstallStatus: true },
  })
  if (!client?.ghlLocationId || !client.leadAlertSnapshotId || client.leadAlertInstallStatus !== 'installed') return
  const status = await getSnapshotPushStatus(await getAgencyContext(), client.leadAlertSnapshotId, client.ghlLocationId)
  if (!status || !/fail|error/i.test(status.status)) return
  const reason = `GHL reports the snapshot load as "${status.status}".`
  await prisma.client.update({
    where: { id: clientId },
    data: { leadAlertInstallStatus: 'failed', leadAlertInstallError: reason },
  })
  await hubAlertThrottled(
    `lead-alert-install:${clientId}`,
    FAILED_RETRY_MS,
    `:warning: *Lead texts for ${client.name} aren't installed* — ${reason} The Hub will try again. <${hubLink('/settings/client-alerts')}|Client SMS → Lead texts>`,
  )
}

/**
 * A lead arriving from the sub-account proves a workflow is there, even
 * one added by hand — recorded against the current snapshot so the sweep
 * doesn't load a second copy.
 */
export async function markLeadAlertInstalled(clientId: string): Promise<void> {
  const config = await prisma.clientAlertsConfig.findUnique({ where: { id: 'singleton' } })
  const snapshotId = config?.leadAlertSnapshotId ?? null
  await prisma.client.updateMany({
    where: {
      id: clientId,
      OR: [
        { leadAlertInstallStatus: null },
        { leadAlertInstallStatus: { not: 'installed' } },
        ...(snapshotId ? [{ leadAlertSnapshotId: null }, { leadAlertSnapshotId: { not: snapshotId } }] : []),
      ],
    },
    data: { leadAlertInstallStatus: 'installed', leadAlertInstallError: null, ...(snapshotId ? { leadAlertSnapshotId: snapshotId } : {}) },
  })
}

export async function sweepLeadAlertInstalls(): Promise<{ attempted: number; installed: number; failed: number }> {
  const config = await prisma.clientAlertsConfig.findUnique({ where: { id: 'singleton' } })
  const snapshotId = config?.leadAlertSnapshotId
  if (!snapshotId) return { attempted: 0, installed: 0, failed: 0 }
  const due = await prisma.client.findMany({
    where: {
      einStatus: 'none',
      active: true,
      OR: [
        { leadAlertInstallStatus: null },
        { leadAlertSnapshotId: null },
        { leadAlertSnapshotId: { not: snapshotId } },
        { leadAlertInstallStatus: 'failed', leadAlertInstallAt: { lt: new Date(Date.now() - FAILED_RETRY_MS) } },
        { leadAlertInstallStatus: 'installing', leadAlertInstallAt: { lt: new Date(Date.now() - IN_FLIGHT_MS) } },
      ],
    },
    select: { id: true },
    take: 20,
  })
  const result = { attempted: due.length, installed: 0, failed: 0 }
  for (const c of due) {
    const r = await installLeadAlertWorkflow(c.id)
    if (r.status === 'installed') result.installed++
    if (r.status === 'failed') result.failed++
  }
  return result
}
