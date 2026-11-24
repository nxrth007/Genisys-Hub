import { prisma } from '@/lib/prisma'
import { ownerPhones } from './number-plan'
import type { HlProfile } from './types'

/** ghl-import.ts's DEFAULT_ACCOUNT_KEY (not imported: that module pulls in the whole GHL importer). */
const HOME_KEY = 'hl.defaultAccount'

/**
 * Genisys's own sending number: an approved number on Lead Genisys (the
 * sub-account with no client; the home one first). Owner alerts and
 * forwarded lead texts go out from it while a client's own number can't
 * text yet. It sits on the same Twilio account as every client's number,
 * which TWILIO_FROM_NUMBER doesn't: Twilio refused every owner alert sent
 * from that one ("Mismatch between the 'From' number and the account",
 * 2026-11-17).
 */
export async function genisysSender(): Promise<{ id: string; accountId: string; number: string } | null> {
  const [home, numbers] = await Promise.all([
    prisma.appSetting.findUnique({ where: { key: HOME_KEY } }),
    prisma.hlPhoneNumber.findMany({
      where: { status: 'active', verificationStatus: 'approved', account: { clientId: null, archivedAt: null } },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      select: { id: true, accountId: true, number: true },
    }),
  ])
  const homeId = home?.value?.trim()
  return numbers.find((n) => n.accountId === homeId) ?? numbers[0] ?? null
}

/**
 * The client sub-accounts this phone belongs to: where the client hears from
 * Genisys OS (their alert phone, business phone, or where their calls and
 * texts are forwarded). Usually one; a phone on two clients' records is two.
 */
export async function clientAccountsForOwnerPhone(phone: string): Promise<{ id: string; clientId: string; name: string; profile: HlProfile }[]> {
  const accounts = await prisma.hlAccount.findMany({
    where: { archivedAt: null, clientId: { not: null } },
    select: { id: true, clientId: true, name: true, profile: true, numbers: { where: { status: 'active' }, select: { forwardTo: true, forwardTextsTo: true } } },
  })
  return accounts.flatMap((a) => {
    const p = (a.profile && typeof a.profile === 'object' && !Array.isArray(a.profile) ? a.profile : {}) as HlProfile
    return (a.numbers.length ? a.numbers : [{}]).some((n) => ownerPhones(n, p).has(phone)) ? [{ id: a.id, clientId: a.clientId!, name: a.name, profile: p }] : []
  })
}

/**
 * Is this phone where a client hears from Genisys OS? A text from it to
 * Genisys's own number is them answering an alert, not a new lead.
 */
export async function isClientOwnerPhone(phone: string): Promise<boolean> {
  return (await clientAccountsForOwnerPhone(phone)).length > 0
}
