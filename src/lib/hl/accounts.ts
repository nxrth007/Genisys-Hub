import { prisma } from '@/lib/prisma'
import { bestIntake, emailOrBlank, looksLikeAddress, notABusinessName } from '@/lib/automation-copy'
import { boardInputs } from '@/lib/automation-copy-server'
import type { Prisma } from '@/generated/prisma/client'
import { applyClientKit, KIT_VERSION } from './client-kit'
import { HlInputError } from './http'
import { toE164 } from './phone'
import type { HlProfile } from './types'

/**
 * Sub-accounts: one per client, made from the client's onboarding answers.
 * Creating one is free (it's rows in the Hub's database, not a GHL plan
 * feature), so every client can have one; phone numbers are the only part
 * that costs money, and those are bought by a person.
 */

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

export function readProfile(v: unknown): HlProfile {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as HlProfile) : {}
}

/** The business profile as the client's onboarding answers, Automation Copy board and Google profile board have it. */
export async function profileForClient(clientId: string): Promise<HlProfile> {
  const [client, inputs, gbp] = await Promise.all([
    prisma.client.findUnique({
      where: { id: clientId },
      select: {
        name: true,
        contactPhone: true,
        address: true,
        ein: true,
        contactEmail: true,
        intakes: { orderBy: { receivedAt: 'desc' }, take: 6, select: { customerPhone: true, businessContact: true, businessAddress: true, ein: true, businessName: true, leadEmail: true } },
      },
    }),
    boardInputs(clientId).catch(() => null),
    prisma.appSetting.findUnique({ where: { key: `gbp.client.${clientId}` } }).catch(() => null),
  ])
  if (!client) throw new HlInputError('That client no longer exists.')
  const intake = bestIntake(client.intakes)
  let reviewLink = ''
  try {
    reviewLink = clean((JSON.parse(gbp?.value ?? '{}') as { reviewUrl?: string }).reviewUrl)
  } catch {
    // no Google profile board yet
  }
  const ownerPhone = toE164(intake?.customerPhone) ?? toE164(client.contactPhone) ?? toE164(intake?.businessContact)
  const ein = clean(intake?.ein || client.ein).replace(/[^\d-]/g, '')
  // Older intakes have the name and address answers crossed: the street address sits in businessName.
  const crossed = looksLikeAddress(intake?.businessName) && !looksLikeAddress(intake?.businessAddress)
  // A phone number or bare web address in the address box isn't an address either.
  const answeredAddress = crossed ? intake?.businessName : /^[\d\s().+-]+$|^\S+\.(com|net|org|co|us|biz|info|io)$/i.test(clean(intake?.businessAddress)) ? null : intake?.businessAddress
  return {
    businessName: (notABusinessName(inputs?.businessName) ? '' : clean(inputs?.businessName)) || clean(client.name),
    ownerFirstName: clean(inputs?.ownerFirstName),
    ownerName: clean(inputs?.ownerFullName),
    businessPhone: clean(inputs?.phone),
    website: clean(inputs?.quoteLink),
    notifyPhone: ownerPhone ?? '',
    notifyEmail: emailOrBlank(inputs?.notifyEmail) || emailOrBlank(intake?.leadEmail) || emailOrBlank(client.contactEmail),
    reviewLink,
    address: clean(answeredAddress || client.address),
    legalName: (notABusinessName(intake?.businessName) ? '' : clean(intake?.businessName)) || clean(client.name),
    ein: ein.replace(/\D/g, '').length === 9 ? ein : '',
  }
}

/**
 * Which US timezone the client is in: their onboarding answer ("Central",
 * "PST", "Eastern daylight", "Texas"…), else the state in their address.
 * null when neither says.
 */
export function zoneFromAnswers(answer: string | null | undefined, address: string | null | undefined): string | null {
  // A website or phone number in the timezone box (crossed answers) says nothing about the zone.
  const said = (answer ?? '').trim()
  const a = /^\S+\.(com|net|org|co|us|biz|info|io)\b|^[\d\s().+-]{7,}$/i.test(said) ? '  ' : ` ${said.toLowerCase()} `
  if (/hawaii|\bhst\b/.test(a)) return 'Pacific/Honolulu'
  if (/alaska|\bakst\b/.test(a)) return 'America/Anchorage'
  if (/arizona|phoenix/.test(a)) return 'America/Phoenix'
  if (/pacific|\bpst\b|\bpdt\b|\bpt\b|california|los.?angeles|washington|oregon|nevada/.test(a)) return 'America/Los_Angeles'
  if (/mountain|\bmst\b|\bmdt\b|\bmt\b|denver|colorado|utah|idaho|montana|new mexico/.test(a)) return 'America/Denver'
  if (/central|\bcst\b|\bcdt\b|\bct\b|texas|chicago|illinois|minnesota|missouri|louisiana|oklahoma|alabama|tennessee/.test(a)) return 'America/Chicago'
  if (/eastern|\best\b|\bedt\b|\bet\b|new.?york|florida|georgia|carolina|ohio|michigan|pennsylvania|virginia|massachusetts|new jersey/.test(a)) return 'America/New_York'
  // Else the state in the address: "Tyler texas 75704", "Ontario CA 91764", "Waycross Ga".
  const tail = (address ?? '').toLowerCase().replace(/\d{5}(-\d{4})?/g, ' ').replace(/[^a-z ]/g, ' ').trim().split(/\s+/).slice(-3).join(' ')
  const states: [RegExp, string][] = [
    [/\b(hawaii|hi)\b/, 'Pacific/Honolulu'],
    [/\b(alaska|ak)\b/, 'America/Anchorage'],
    [/\b(arizona|az)\b/, 'America/Phoenix'],
    [/\b(california|ca|washington|wa|oregon|or|nevada|nv)\b/, 'America/Los_Angeles'],
    [/\b(colorado|co|utah|ut|idaho|id|montana|mt|wyoming|wy|new mexico|nm)\b/, 'America/Denver'],
    [/\b(texas|tx|illinois|il|minnesota|mn|missouri|mo|louisiana|la|oklahoma|ok|alabama|al|tennessee|tn|wisconsin|wi|iowa|ia|kansas|ks|nebraska|ne|arkansas|ar|mississippi|ms)\b/, 'America/Chicago'],
    [/\b(new york|ny|florida|fl|georgia|ga|north carolina|south carolina|nc|sc|ohio|oh|michigan|mi|pennsylvania|pa|virginia|va|massachusetts|ma|new jersey|nj|maryland|md|connecticut|ct|indiana|in|kentucky|ky|maine|me|new hampshire|nh|vermont|vt|rhode island|ri|delaware|de|west virginia|wv|dc)\b/, 'America/New_York'],
  ]
  return states.find(([re]) => re.test(tail))?.[1] ?? null
}

/** The client's timezone from their onboarding answers, if they say. */
export async function zoneForClient(clientId: string): Promise<string | null> {
  const c = await prisma.client.findUnique({
    where: { id: clientId },
    select: { address: true, intakes: { orderBy: { receivedAt: 'desc' }, take: 6, select: { timeZone: true, businessName: true, businessAddress: true, leadEmail: true } } },
  })
  if (!c) return null
  const i = bestIntake(c.intakes)
  const address = i && looksLikeAddress(i.businessName) && !looksLikeAddress(i.businessAddress) ? i.businessName : (i?.businessAddress ?? c.address)
  return zoneFromAnswers(i?.timeZone, address) ?? zoneFromAnswers(null, c.address)
}

/**
 * The pipeline, forms and automations a new sub-account starts with: the
 * client kit (GHL's client workflows, src/lib/hl/client-kit.ts). Safe to run
 * again: it only adds what's missing.
 */
export async function ensureStarterKit(accountId: string): Promise<void> {
  await applyClientKit(accountId)
}

/** The client's sub-account, made (with its starter kit) if it doesn't exist yet. */
export async function createAccountForClient(clientId: string): Promise<{ id: string; created: boolean }> {
  const existing = await prisma.hlAccount.findUnique({ where: { clientId }, select: { id: true } })
  if (existing) return { id: existing.id, created: false }
  const [profile, zone] = await Promise.all([profileForClient(clientId), zoneForClient(clientId)])
  const account = await prisma.hlAccount
    .create({
      data: { clientId, name: profile.businessName || 'New sub-account', profile: profile as Prisma.InputJsonValue, ...(zone ? { timezone: zone } : {}) },
      select: { id: true },
    })
    .catch(async (err) => {
      // Two clicks at once: the unique clientId lets only one through.
      const again = await prisma.hlAccount.findUnique({ where: { clientId }, select: { id: true } })
      if (again) return again
      throw err
    })
  await ensureStarterKit(account.id)
  return { id: account.id, created: true }
}

/**
 * Put right what onboarding's crossed answers got wrong in a client
 * sub-account (an address as the business name, a phone number as the alert
 * email, New York time for a client in Texas), and fill what's blank. Anything
 * that already looks right, typed by hand or not, is left as it is.
 */
export async function repairClientProfile(accountId: string): Promise<string[]> {
  const a = await prisma.hlAccount.findUnique({ where: { id: accountId }, select: { clientId: true, name: true, profile: true, timezone: true } })
  if (!a?.clientId) return []
  const now = readProfile(a.profile) as Record<string, string | undefined>
  const fresh = (await profileForClient(a.clientId)) as Record<string, string | undefined>
  const next: Record<string, string | undefined> = { ...now }
  const fixed: string[] = []
  const take = (key: string, wrong: boolean) => {
    if (wrong && fresh[key]?.trim() && fresh[key] !== now[key]) {
      next[key] = fresh[key]
      fixed.push(key)
    }
  }
  take('businessName', notABusinessName(now.businessName))
  take('legalName', notABusinessName(now.legalName))
  take('notifyEmail', !emailOrBlank(now.notifyEmail))
  for (const key of ['ownerFirstName', 'ownerName', 'businessPhone', 'website', 'notifyPhone', 'reviewLink', 'address', 'ein']) take(key, !now[key]?.trim())
  const data: Prisma.HlAccountUpdateInput = {}
  if (fixed.length) data.profile = next as Prisma.InputJsonValue
  if (notABusinessName(a.name) && next.businessName) {
    data.name = next.businessName
    fixed.push('name')
  }
  // Only from the default: a timezone someone picked stays.
  if (a.timezone === 'America/New_York') {
    const zone = await zoneForClient(a.clientId)
    if (zone && zone !== a.timezone) {
      data.timezone = zone
      fixed.push('timezone')
    }
  }
  if (Object.keys(data).length) await prisma.hlAccount.update({ where: { id: accountId }, data })
  return fixed
}

let upgradedTo = 0

/**
 * Once per client-kit version, on the first scheduler tick after a deploy:
 * every client sub-account repaired and brought up to the kit (what POST
 * /api/hl/accounts { clientKit: 'all' } does by hand). A marker claimed first
 * keeps two containers of a rolling deploy from both doing it.
 */
export async function maybeUpgradeClientAccounts(): Promise<number> {
  if (upgradedTo >= KIT_VERSION) return 0
  const key = `hl.clientKit.v${KIT_VERSION}`
  if (await prisma.appSetting.findUnique({ where: { key }, select: { id: true } })) {
    upgradedTo = KIT_VERSION
    return 0
  }
  try {
    await prisma.appSetting.create({ data: { key, value: 'running' } })
  } catch {
    return 0 // another container got there first
  }
  upgradedTo = KIT_VERSION
  const accounts = await prisma.hlAccount.findMany({ where: { archivedAt: null, clientId: { not: null } }, select: { id: true } })
  for (const a of accounts) {
    await repairClientProfile(a.id)
    await applyClientKit(a.id)
  }
  await prisma.appSetting.update({ where: { key }, data: { value: `done ${new Date().toISOString()}: ${accounts.length} sub-accounts` } })
  return accounts.length
}

/** A sub-account with no client behind it (the agency's own, a test account…). */
export async function createStandaloneAccount(name: string): Promise<{ id: string }> {
  const n = clean(name)
  if (!n) throw new HlInputError('Give the sub-account a name.')
  const account = await prisma.hlAccount.create({ data: { name: n, profile: { businessName: n } }, select: { id: true } })
  await ensureStarterKit(account.id)
  return account
}

/** Merge profile changes; blank strings clear a value. */
export function mergeProfile(current: HlProfile, patch: Record<string, unknown>): HlProfile {
  const next: Record<string, string> = { ...(current as Record<string, string>) }
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v !== 'string') continue
    next[k] = k === 'notifyPhone' ? v.trim() : clean(v)
  }
  return next as HlProfile
}
