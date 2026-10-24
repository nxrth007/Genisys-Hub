/**
 * A2P 10DLC for local numbers: what the review screen collects and shows.
 * Client-safe (no database); the filing itself is in a2p.ts.
 */

/** Which registration: an EIN business sending under ~2,000 texts a day, one sending more, or a sole proprietor without an EIN. */
export type A2pPath = 'low_volume' | 'standard' | 'sole_prop'

/** draft → profile (Trust Hub filed) → brand (registry checking) → otp (sole prop: owner's YES) → campaign (carriers reviewing) → approved, or failed. */
export type A2pStage = 'draft' | 'profile' | 'brand' | 'otp' | 'campaign' | 'approved' | 'failed'

export const ACTIVE_STAGES: A2pStage[] = ['profile', 'brand', 'otp', 'campaign']

export type A2pDetails = {
  path: A2pPath
  /** Exactly as on the IRS EIN letter (CP 575). */
  legalName: string
  businessType: string
  /** 12-3456789 */
  ein: string
  industry: string
  website: string
  street: string
  city: string
  /** Two letters. */
  state: string
  zip: string
  /** The authorized representative (for a sole proprietor, the owner). */
  firstName: string
  lastName: string
  title: string
  position: string
  email: string
  /** E.164. For a sole proprietor, the owner's own cell: the registry texts it and they reply YES. */
  phone: string
  /** Sole proprietor only: the business name, or the owner's name when there's none. */
  brandName: string
  /** The business's own policy pages (or the ones the Hub hosts). The campaign cites them; filing also saves them to the Business Profile, so the forms link to the same pages. */
  privacyUrl: string
  termsUrl: string
  description: string
  messageFlow: string
  samples: string[]
  /** Some texts are promotions (people ticked the separate marketing box). */
  marketing: boolean
}

export type A2pCheck = {
  key: string
  level: 'ok' | 'warning' | 'error'
  label: string
  detail: string
  /** A one-click correction the screen can offer ("Use https://www.…"). */
  fix?: { label: string; patch: Partial<A2pDetails> }
}

export type A2pView = {
  path: A2pPath
  stage: A2pStage
  brandStatus: string | null
  identityStatus: string | null
  campaignStatus: string | null
  note: string | null
  filedAt: string | null
  approvedAt: string | null
  checkedAt: string | null
  /** Sole proprietor: the cell the registry texted. */
  otpPhone: string | null
  /** Local numbers on the campaign (E.164). */
  numbers: string[]
}

/** What Twilio charges (passed through from the registry and carriers), per Twilio's A2P pricing as of Aug 2025. */
export const A2P_FEES: Record<A2pPath, { label: string; hint: string; brand: number; campaign: number; monthly: number }> = {
  low_volume: { label: 'Low volume', hint: 'Has an EIN, sends under 2,000 texts a day. Every contractor.', brand: 4.5, campaign: 15, monthly: 1.5 },
  standard: { label: 'Standard', hint: 'Has an EIN, sends more than 2,000 texts a day. Includes a vetting score.', brand: 46, campaign: 15, monthly: 10 },
  sole_prop: { label: 'Sole proprietor', hint: 'No EIN. The owner replies YES to one text from the registry.', brand: 4.5, campaign: 15, monthly: 2 },
}

const usd = (n: number) => `$${n % 1 ? n.toFixed(2) : n}`

export function feeLine(path: A2pPath): { now: string; monthly: string; text: string } {
  const f = A2P_FEES[path]
  const now = usd(f.brand + f.campaign)
  const monthly = usd(f.monthly)
  return { now, monthly, text: `${now} once (${usd(f.brand)} brand + ${usd(f.campaign)} campaign review), then ${monthly} a month` }
}

export const BUSINESS_TYPES = ['Limited Liability Corporation', 'Corporation', 'Partnership', 'Co-operative', 'Non-profit Corporation'] as const

export const JOB_POSITIONS = ['CEO', 'Director', 'GM', 'VP', 'CFO', 'General Counsel', 'Other'] as const

export const INDUSTRIES = [
  'AGRICULTURE', 'AUTOMOTIVE', 'BANKING', 'CONSTRUCTION', 'CONSUMER', 'EDUCATION', 'ELECTRONICS', 'ENGINEERING', 'ENERGY',
  'FAST_MOVING_CONSUMER_GOODS', 'FINANCIAL', 'FINTECH', 'FOOD_AND_BEVERAGE', 'GOVERNMENT', 'HEALTHCARE', 'HOSPITALITY',
  'INSURANCE', 'JEWELRY', 'LEGAL', 'MANUFACTURING', 'MEDIA', 'NOT_FOR_PROFIT', 'OIL_AND_GAS', 'ONLINE', 'PROFESSIONAL_SERVICES',
  'RAW_MATERIALS', 'REAL_ESTATE', 'RELIGION', 'RETAIL', 'TECHNOLOGY', 'TELECOMMUNICATIONS', 'TRANSPORTATION', 'TRAVEL',
] as const

export const industryLabel = (v: string) => v.charAt(0) + v.slice(1).toLowerCase().replace(/_/g, ' ')

export const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN',
  'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA',
  'WA', 'WV', 'WI', 'WY',
]

/** Twilio's limits on the campaign fields. */
export const LIMITS = { description: [40, 4096], messageFlow: [40, 2048], sample: [20, 1024], samples: [2, 5] } as const

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const LINK = /^https?:\/\/[^\s/$.?#][^\s]*$/i

/** What has to be fixed before anything can be filed (the server checks the same). */
export function detailProblems(d: A2pDetails): string[] {
  const out: string[] = []
  const sole = d.path === 'sole_prop'
  if (!sole) {
    if (!d.legalName.trim()) out.push('Legal business name is missing.')
    if (!(BUSINESS_TYPES as readonly string[]).includes(d.businessType)) out.push('Pick the business type.')
    if (d.ein.replace(/\D/g, '').length !== 9) out.push('EIN must be 9 digits.')
    if (!(INDUSTRIES as readonly string[]).includes(d.industry)) out.push('Pick the industry.')
    if (!d.title.trim()) out.push('The representative’s job title is missing.')
    if (!(JOB_POSITIONS as readonly string[]).includes(d.position)) out.push('Pick the representative’s position.')
  } else {
    if (!d.brandName.trim()) out.push('Brand name is missing (the business name, or the owner’s name if there’s none).')
    // The registry's rule: sole proprietor is only for a business with no tax ID (every LLC has an EIN).
    if (d.ein.replace(/\D/g, '').length === 9) out.push('This business has an EIN, so it can’t register as a sole proprietor: pick Low volume.')
  }
  if (!LINK.test(d.website.trim())) out.push('Website must be a full link (https://…).')
  if (!LINK.test(d.privacyUrl.trim())) out.push('The privacy policy link must be a full link (https://…).')
  if (!LINK.test(d.termsUrl.trim())) out.push('The terms link must be a full link (https://…).')
  if (!d.street.trim() || !d.city.trim()) out.push('Street address and city are needed.')
  if (!US_STATES.includes(d.state.trim().toUpperCase())) out.push('State must be a two-letter code (NH, TX…).')
  if (!/^\d{5}(-\d{4})?$/.test(d.zip.trim())) out.push('ZIP must be 5 digits.')
  if (!d.firstName.trim() || !d.lastName.trim()) out.push(sole ? 'The owner’s first and last name are needed.' : 'The representative’s first and last name are needed.')
  if (!EMAIL.test(d.email.trim())) out.push('Email isn’t valid.')
  if (!/^\+1[2-9]\d{9}$/.test(d.phone.trim())) out.push(sole ? 'The owner’s cell number isn’t a valid US number.' : 'Phone isn’t a valid US number.')
  const [dMin, dMax] = LIMITS.description
  if (d.description.trim().length < dMin || d.description.trim().length > dMax) out.push(`The campaign description must be ${dMin}–${dMax} characters.`)
  const [fMin, fMax] = LIMITS.messageFlow
  if (d.messageFlow.trim().length < fMin || d.messageFlow.trim().length > fMax) out.push(`“How people opt in” must be ${fMin}–${fMax} characters.`)
  const samples = d.samples.map((s) => s.trim()).filter(Boolean)
  if (samples.length < LIMITS.samples[0] || samples.length > LIMITS.samples[1]) out.push('Give 2 to 5 sample messages.')
  if (samples.some((s) => s.length < LIMITS.sample[0] || s.length > LIMITS.sample[1])) out.push(`Each sample message must be ${LIMITS.sample[0]}–${LIMITS.sample[1]} characters.`)
  return out
}

/** What the number card says about where a registration is. */
export function stageText(v: Pick<A2pView, 'stage' | 'path' | 'brandStatus' | 'campaignStatus'>): string {
  switch (v.stage) {
    case 'draft':
      return 'Not filed yet.'
    case 'profile':
      return 'Business profile filed with Twilio. The brand is registered with The Campaign Registry next (within a few minutes).'
    case 'brand':
      return 'Brand registered. The Campaign Registry checks the business against IRS records, usually within minutes, sometimes a few days.'
    case 'otp':
      return 'Waiting for the owner: the registry texted their cell from (915) 278-2000. They reply YES (within 24 hours).'
    case 'campaign':
      return 'Campaign filed. Carriers review it, usually within a few days, sometimes two to three weeks. Hell-level checks every 30 minutes.'
    case 'approved':
      return 'Approved. Texts go out from this number.'
    case 'failed':
      return 'Rejected.'
  }
}
