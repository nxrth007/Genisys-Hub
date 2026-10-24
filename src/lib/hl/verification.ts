import { prisma } from '@/lib/prisma'
import { parseUsAddress } from '@/lib/address-parse'
import { readProfile } from './accounts'
import { HlInputError } from './http'
import { renderTemplate } from './merge'
import { splitName, toE164 } from './phone'
import { asSettings, consentsOf } from './forms'
import { resolveLegalLinks } from './legal-links'
import { publicBase, twilioClient } from './twilio'

/**
 * Toll-free verification: texting for toll-free numbers with no A2P fees.
 *
 * Local (10DLC) numbers are registered for A2P instead (a2p.ts: a brand and
 * a campaign, about $19.50 once and $1.50 a month). Toll-free numbers are
 * verified differently: one form per number, filed with Twilio's API from
 * what the Hub already knows (business name, website, EIN from onboarding,
 * the opt-in form, sample messages), free, no code from the client. Twilio
 * says it reviews within about three business days; until then a toll-free
 * number can't text (owner notifications fall back to the Hub's own number
 * meanwhile).
 *
 * The Trust Hub business profile (CustomerProfileSid) is Genisys's own: set
 * once in the Twilio Console, Twilio-approved, then used for every client.
 */

const SETTINGS_KEY = 'hl.twilio'

export type HlTwilioSettings = {
  /** Genisys's Trust Hub business profile (BU…). Blank = the first Twilio-approved one. */
  customerProfileSid?: string
  /** Where Twilio emails verification updates. */
  notificationEmail?: string
}

export async function readTwilioSettings(): Promise<HlTwilioSettings> {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } })
  try {
    return row ? (JSON.parse(row.value) as HlTwilioSettings) : {}
  } catch {
    return {}
  }
}

export async function saveTwilioSettings(s: HlTwilioSettings): Promise<void> {
  const value = JSON.stringify(s)
  await prisma.appSetting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value }, update: { value } })
}

/** Genisys's own approved Trust Hub profile (toll-free verifications are filed under it, and A2P profiles are tied to it). */
export async function primaryProfileSid(): Promise<string> {
  const s = await readTwilioSettings()
  if (s.customerProfileSid?.trim()) return s.customerProfileSid.trim()
  const client = await twilioClient()
  const profiles = await client.trusthub.v1.customerProfiles.list({ limit: 20 })
  const approved = profiles.find((p) => p.status === 'twilio-approved')
  if (!approved) {
    throw new HlInputError(
      'Twilio needs Genisys’s business profile first: in the Twilio Console open Trust Hub → Customer Profiles, create the Primary Business Profile (choose “ISV / Reseller”), and wait for “Twilio Approved”. Then file again.',
    )
  }
  return approved.sid
}

const STATUS: Record<string, string> = {
  PENDING_REVIEW: 'pending',
  IN_REVIEW: 'in_review',
  TWILIO_APPROVED: 'approved',
  TWILIO_REJECTED: 'rejected',
}

export const formUrl = (formId: string) => `${publicBase()}/hl/f/${formId}`

/** What would be filed, for the review screen and the request itself. Throws with what's missing. */
export async function verificationDraft(numberId: string) {
  const number = await prisma.hlPhoneNumber.findUnique({ where: { id: numberId }, include: { account: { include: { forms: { where: { archivedAt: null } }, workflows: true } } } })
  if (!number || number.status !== 'active') throw new HlInputError('That number isn’t active.')
  if (number.kind !== 'toll_free') throw new HlInputError('Only toll-free numbers are verified this way. Local numbers are registered for A2P instead (the Texting panel on the number).')
  if (!number.providerSid) throw new HlInputError('The number has no Twilio id; buy it through Hell-level.')
  const p = readProfile(number.account.profile)
  const missing = [
    !p.businessName && 'business name',
    !p.website && 'website',
    !p.notifyEmail && 'notification email',
  ].filter(Boolean)
  if (missing.length) throw new HlInputError(`Fill in the business profile first: ${missing.join(', ')} (Settings → Business Profile).`)
  const website = /^https?:\/\//i.test(p.website!) ? p.website! : `https://${p.website}`
  // Hell-level's own forms (an imported GHL form isn't served from here).
  const own = number.account.forms.filter((f) => !f.ghlId)
  const quote = own.find((f) => f.kind === 'form')
  const chat = own.find((f) => f.kind === 'chat')
  // A form with the separate promotional box means some texts are marketing, and the filing has to say so.
  const promos = own.some((f) => consentsOf(asSettings(f.settings)).some((c) => c.kind === 'marketing'))
  const legal = resolveLegalLinks(number.accountId, p)
  const sample = renderTemplate(
    "Hey {{contact.first_name}}! Just got your quote form.\n\nI'll be in touch with you shortly. Please feel free to reach out to us directly at {{account.business_phone}}\n\n- {{account.owner_name}} at {{account.business_name}}\n\nReply STOP to opt out.",
    { contact: { firstName: 'Jennifer' }, account: p },
  )
  const ein = (p.ein ?? '').replace(/\D/g, '')
  const owner = splitName(p.ownerName || p.ownerFirstName)
  const addr = parseUsAddress(p.address)
  const business = p.legalName || p.businessName!
  return {
    number,
    request: {
      tollfreePhoneNumberSid: number.providerSid,
      businessName: business,
      ...(p.businessName && p.businessName !== business ? { doingBusinessAs: p.businessName } : {}),
      businessWebsite: website,
      businessType: (ein.length === 9 ? 'PRIVATE_PROFIT' : 'SOLE_PROPRIETOR') as 'PRIVATE_PROFIT' | 'SOLE_PROPRIETOR',
      ...(ein.length === 9 ? { businessRegistrationNumber: ein, businessRegistrationAuthority: 'EIN' as const, businessRegistrationCountry: 'US' } : {}),
      ...(addr.street && addr.city && addr.state && addr.zip
        ? { businessStreetAddress: addr.street, businessCity: addr.city, businessStateProvinceRegion: addr.state, businessPostalCode: addr.zip, businessCountry: 'US' }
        : {}),
      ...(owner.firstName ? { businessContactFirstName: owner.firstName, businessContactLastName: owner.lastName ?? owner.firstName } : {}),
      businessContactEmail: (p.notifyEmail ?? '').split(/[,;\s]+/)[0],
      ...(toE164(p.notifyPhone?.split(',')[0]) ? { businessContactPhone: toE164(p.notifyPhone?.split(',')[0])! } : {}),
      useCaseCategories: promos ? ['CUSTOMER_CARE', 'MARKETING'] : ['CUSTOMER_CARE'],
      useCaseSummary: `${p.businessName} is a local contractor. This number replies to people who ask for a quote: when someone submits the quote form or chat widget on ${website} and ticks the texting consent box, or calls or texts this number first, we text them back to confirm their request and arrange the job.${promos ? ' Occasional promotional texts (seasonal specials and discounts, 1-2 a month) go only to people who also tick the separate, optional marketing box.' : ' No marketing lists.'} Customers can reply STOP at any time.`,
      productionMessageSample: sample,
      optInType: 'WEB_FORM' as const,
      optInImageUrls: [quote && formUrl(quote.id), chat && formUrl(chat.id), website].filter((u): u is string => !!u),
      optInConfirmationMessage: `${p.businessName}: thanks for reaching out! We'll text you about your request. Msg & data rates may apply. Reply STOP to opt out, HELP for help.`,
      helpMessageSample: `${p.businessName}: for help call ${p.businessPhone || 'us'} or visit ${website}. Reply STOP to opt out.`,
      messageVolume: '1,000',
      privacyPolicyUrl: legal.privacy,
      termsAndConditionsUrl: legal.terms,
      additionalInformation: 'Filed by Genisys (marketing agency) on behalf of its client, which owns this number’s traffic. Consent is collected on the client’s website form shown in the opt-in links.',
      externalReferenceId: number.accountId,
      ageGatedContent: false,
    },
  }
}

/** File (or re-file after a rejection) the toll-free verification for a number. */
export async function submitVerification(numberId: string): Promise<{ status: string; sid: string }> {
  const { number, request } = await verificationDraft(numberId)
  if (number.verificationStatus === 'approved') throw new HlInputError('This number is already approved.')
  if ((number.verificationStatus === 'pending' || number.verificationStatus === 'in_review') && number.verificationSid) {
    throw new HlInputError('A verification is already with Twilio for this number. Use “Check status”.')
  }
  const notificationEmail = (await readTwilioSettings()).notificationEmail?.trim() || 'alex@leadgenisys.com'
  const client = await twilioClient()
  const customerProfileSid = await primaryProfileSid()
  const params = { ...request, notificationEmail, customerProfileSid }
  // A rejected verification is edited and resubmitted rather than filed again.
  const v =
    number.verificationStatus === 'rejected' && number.verificationSid
      ? await client.messaging.v1.tollfreeVerifications(number.verificationSid).update({ ...params, editReason: 'Updated details after review' })
      : await client.messaging.v1.tollfreeVerifications.create(params)
  const status = STATUS[v.status] ?? 'pending'
  await prisma.hlPhoneNumber.update({
    where: { id: numberId },
    data: { verificationSid: v.sid, verificationStatus: status, verificationNote: null, verificationAt: new Date() },
  })
  return { status, sid: v.sid }
}

/** Ask Twilio where a verification stands. */
export async function refreshVerification(numberId: string): Promise<{ status: string; note: string | null }> {
  const number = await prisma.hlPhoneNumber.findUnique({ where: { id: numberId } })
  if (!number?.verificationSid) throw new HlInputError('Nothing filed for this number yet.')
  const client = await twilioClient()
  const v = await client.messaging.v1.tollfreeVerifications(number.verificationSid).fetch()
  const status = STATUS[v.status] ?? number.verificationStatus
  const note = v.rejectionReason || (v.errorCode ? `Error ${v.errorCode}` : null)
  await prisma.hlPhoneNumber.update({ where: { id: numberId }, data: { verificationStatus: status, verificationNote: note } })
  return { status, note }
}

/** Every 30 minutes: check pending verifications, so a number starts texting soon after Twilio approves it. */
let lastSweep = 0
export async function maybeRefreshVerifications(): Promise<number> {
  if (Date.now() - lastSweep < 30 * 60_000) return 0
  lastSweep = Date.now()
  const pending = await prisma.hlPhoneNumber.findMany({ where: { status: 'active', kind: 'toll_free', verificationStatus: { in: ['pending', 'in_review'] }, verificationSid: { not: null } }, select: { id: true } })
  let changed = 0
  for (const n of pending) {
    try {
      const before = await prisma.hlPhoneNumber.findUnique({ where: { id: n.id }, select: { verificationStatus: true } })
      const r = await refreshVerification(n.id)
      if (r.status !== before?.verificationStatus) changed++
    } catch (err) {
      console.warn(`[hell-level] verification refresh ${n.id}:`, err instanceof Error ? err.message : err)
    }
  }
  return changed
}
