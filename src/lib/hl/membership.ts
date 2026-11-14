/**
 * A sub-account's membership card (Hell-level → Memberships): the records the Hub keeps about the
 * client, read into ./membership-plan.ts. For a sub-account copied from GoHighLevel, GoHighLevel's
 * own date for it is asked once and kept (AppSetting hl.ghlAdded:<locationId>); a read-only call.
 */
import { prisma } from '@/lib/prisma'
import { getAgencyContext, getLocation } from '@/lib/ghl-agency'
import { membershipOf, type Membership } from './membership-plan'

const ADDED_KEY = 'hl.ghlAdded:'
/** GoHighLevel didn't give a date: asked again after this long. */
const RECHECK_MS = 7 * 86_400_000

/** When GoHighLevel made the sub-account, from its location record; null when it doesn't say. Never throws. */
async function ghlLocationAddedAt(locationId: string): Promise<Date | null> {
  const key = ADDED_KEY + locationId
  try {
    const row = await prisma.appSetting.findUnique({ where: { key } })
    const kept = row ? (JSON.parse(row.value) as { at?: string | null; checkedAt?: string }) : null
    if (kept?.at) return new Date(kept.at)
    if (kept?.checkedAt && Date.now() - Date.parse(kept.checkedAt) < RECHECK_MS) return null
    const loc = await getLocation(await getAgencyContext(), locationId)
    const at = loc?.dateAdded ?? null
    const value = JSON.stringify({ at, checkedAt: new Date().toISOString() })
    await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
    return at ? new Date(at) : null
  } catch (err) {
    console.warn(`[hl-membership] GoHighLevel's date for ${locationId}:`, err instanceof Error ? err.message : err)
    return null
  }
}

export async function readMembership(accountId: string): Promise<Membership | null> {
  const a = await prisma.hlAccount.findUnique({
    where: { id: accountId },
    select: {
      createdAt: true,
      ghlLocationId: true,
      clientId: true,
      numbers: { where: { status: 'active' }, orderBy: { createdAt: 'asc' }, select: { number: true, kind: true, createdAt: true, verificationStatus: true, verificationAt: true } },
      domains: { where: { status: { not: 'failed' } }, orderBy: { createdAt: 'asc' }, select: { name: true, createdAt: true } },
      members: { orderBy: { invitedAt: 'asc' }, select: { invitedAt: true, lastLoginAt: true, user: { select: { name: true, email: true } } } },
    },
  })
  if (!a) return null
  const c = a.clientId
    ? await prisma.client.findUnique({
        where: { id: a.clientId },
        select: {
          createdAt: true,
          archivedAt: true,
          lifecycle: true,
          siteUrl: true,
          siteLiveAt: true,
          ghlProvisionStatus: true,
          ghlProvisionedAt: true,
          intakes: { orderBy: { receivedAt: 'asc' }, take: 1, select: { receivedAt: true } },
          journeyStages: { where: { stage: { in: ['signup', 'subaccount'] }, status: 'done' }, select: { stage: true, note: true, completedAt: true } },
          tracker: { select: { startDate: true } },
        },
      })
    : null
  const step = (stage: string) => c?.journeyStages.find((s) => s.stage === stage) ?? null
  return membershipOf({
    signupStep: step('signup'),
    subAccountStep: step('subaccount'),
    firstIntakeAt: c?.intakes[0]?.receivedAt ?? null,
    trackerStart: c?.tracker?.startDate ?? null,
    clientAddedAt: c?.createdAt ?? null,
    ghlProvision: { status: c?.ghlProvisionStatus ?? null, at: c?.ghlProvisionedAt ?? null },
    ghlLocationAddedAt: a.ghlLocationId ? await ghlLocationAddedAt(a.ghlLocationId) : null,
    accountCreatedAt: a.createdAt,
    ghlLocationId: a.ghlLocationId,
    siteLiveAt: c?.siteLiveAt ?? null,
    siteUrl: c?.siteUrl ?? null,
    numbers: a.numbers,
    domains: a.domains,
    logins: a.members.map((m) => ({ who: m.user.name?.trim() || m.user.email, invitedAt: m.invitedAt, lastLoginAt: m.lastLoginAt })),
    archivedAt: c?.archivedAt ?? null,
    lifecycle: c?.lifecycle ?? null,
  })
}
