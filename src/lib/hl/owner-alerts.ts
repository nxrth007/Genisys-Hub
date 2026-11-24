import { prisma } from '@/lib/prisma'
import type { OwnerAlertView } from './owner-text-plan'

/**
 * The lead each owner phone was last told about (a kit alert, a forwarded text, a booking), so a reply
 * from that phone can be sent on to the right lead (./owner-text.ts). One HlRecord per owner phone and
 * sub-account: kind owner_alert, keyed on ghlId (the model's unique is accountId + kind + ghlId), so two
 * alerts landing at once can't make two rows.
 */
export const OWNER_ALERT_KIND = 'owner_alert'

const keyFor = (phone: string) => `${OWNER_ALERT_KIND}:${phone}`

const read = (data: unknown): OwnerAlertView | null => {
  const d = (data ?? null) as { contactId?: unknown; at?: unknown; prev?: unknown; confirmedAt?: unknown } | null
  if (!d || typeof d.contactId !== 'string' || typeof d.at !== 'string') return null
  const p = (d.prev ?? null) as { contactId?: unknown; at?: unknown } | null
  return {
    contactId: d.contactId,
    at: d.at,
    prev: p && typeof p.contactId === 'string' && typeof p.at === 'string' ? { contactId: p.contactId, at: p.at } : null,
    confirmedAt: typeof d.confirmedAt === 'string' ? d.confirmedAt : null,
  }
}

/** The owner was just told about this lead. The one before is kept, for a reply that could be for either. */
export async function noteOwnerAlert(accountId: string, phones: string[], contactId: string): Promise<void> {
  const at = new Date().toISOString()
  for (const phone of [...new Set(phones)]) {
    const where = { accountId_kind_ghlId: { accountId, kind: OWNER_ALERT_KIND, ghlId: keyFor(phone) } }
    const was = read((await prisma.hlRecord.findUnique({ where, select: { data: true } }))?.data)
    const prev = was && was.contactId !== contactId ? { contactId: was.contactId, at: was.at } : (was?.prev ?? null)
    const data = { contactId, at, prev }
    await prisma.hlRecord.upsert({ where, create: { accountId, kind: OWNER_ALERT_KIND, ghlId: keyFor(phone), name: phone, data }, update: { data } })
  }
}

/** The Hub just confirmed a relay to this owner: their "ok" in the next minutes is for the Hub. */
export async function noteOwnerConfirmed(accountId: string, phone: string): Promise<void> {
  const where = { accountId_kind_ghlId: { accountId, kind: OWNER_ALERT_KIND, ghlId: keyFor(phone) } }
  const row = await prisma.hlRecord.findUnique({ where, select: { data: true } })
  const was = read(row?.data)
  if (!was) return
  await prisma.hlRecord.update({ where, data: { data: { ...was, confirmedAt: new Date().toISOString() } } })
}

export async function latestOwnerAlert(accountId: string, phone: string): Promise<OwnerAlertView | null> {
  const row = await prisma.hlRecord.findUnique({ where: { accountId_kind_ghlId: { accountId, kind: OWNER_ALERT_KIND, ghlId: keyFor(phone) } }, select: { data: true } })
  return read(row?.data)
}
