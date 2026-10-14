import { parseUsAddress } from './address-parse'
/**
 * A2P 10DLC registration copy for a client, from the GHL A2P master
 * template (built from real rejections and approvals across A Plus
 * Fence, Tru Shield Coatings and Blue Diamond Construction).
 *
 * Values come from the client's onboarding answers; anything the form
 * doesn't know (trade, the promo offer) is typed on the A2P board and
 * saved per client. A value still missing renders as {{LABEL}} so the
 * board can highlight it and the copy comes out as [LABEL].
 */

export type A2pInputs = {
  businessName: string
  legalName: string
  ein: string
  contactEmail: string
  ownerFirstName: string
  trade: string
  city: string
  state: string
  ownership: string
  serviceArea: string
  address: string
  domain: string
  phone: string
  promoLabel: string
  offer: string
  offerBy: string
  primaryCities: string
}

export const A2P_INPUT_KEYS = [
  'businessName',
  'legalName',
  'ein',
  'contactEmail',
  'ownerFirstName',
  'trade',
  'city',
  'state',
  'ownership',
  'serviceArea',
  'address',
  'domain',
  'phone',
  'promoLabel',
  'offer',
  'offerBy',
  'primaryCities',
] as const satisfies readonly (keyof A2pInputs)[]

export type A2pSource = {
  name: string
  contactName: string | null
  contactEmail: string | null
  contactPhone: string | null
  address: string | null
  siteUrl: string | null
  website: string | null
  intake: {
    fullName: string | null
    businessName: string | null
    businessAddress: string | null
    customerPhone: string | null
    leadEmail: string | null
    cities: string | null
    website: string | null
    domainName: string | null
    yearStarted: string | null
    ein: string | null
  } | null
}

const STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

/** "https://www.Example.com/contact/" → "www.example.com". Keeps www as given. */
export function hostOnly(url: string | null | undefined): string {
  const s = clean(url)
  if (!s) return ''
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).host.toLowerCase()
  } catch {
    return s.replace(/^https?:\/\//i, '').split(/[/?#]/)[0].toLowerCase()
  }
}

/** City and full state name from however the client wrote the address (see address-resolve.ts). */
export function cityState(address: string): { city: string; state: string } {
  const p = parseUsAddress(address)
  return { city: p.city, state: p.stateName || (p.state ? (STATES[p.state] ?? p.state) : '') }
}

/** "(830) 555-0123" for a US number; anything else as typed. */
export function formatPhone(raw: string | null | undefined): string {
  const s = clean(raw)
  const d = s.replace(/\D/g, '')
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : s
}

/** Years in business from answers like "2001", "since 1999" or "25 years". */
export function yearsInBusiness(raw: string | null | undefined, now: Date): number | null {
  const s = clean(raw)
  const year = s.match(/\b(19\d{2}|20\d{2})\b/)
  if (year) {
    const n = now.getFullYear() - Number(year[1])
    return n >= 1 && n <= 150 ? n : null
  }
  const n = s.match(/(\d{1,3})\s*\+?\s*(?:years?|yrs?)/i)
  return n ? Number(n[1]) : null
}

export function splitCities(raw: string): string[] {
  return raw
    .split(/[,;/\n]|\band\b|&/i)
    .map((c) => clean(c).replace(/\.$/, ''))
    .filter((c) => c.length > 1)
}

function seasonLabel(now: Date): string {
  const m = now.getMonth()
  if (m <= 1 || m === 11) return 'Winter special'
  if (m <= 4) return 'Spring special'
  if (m <= 7) return 'Summer special'
  return 'Fall special'
}

/** Everything the onboarding answers can fill in. */
export function a2pPrefill(src: A2pSource, now = new Date()): A2pInputs {
  const i = src.intake
  const businessName = clean(i?.businessName) || clean(src.name)
  const fullName = clean(i?.fullName) || clean(src.contactName)
  const ownerFirstName = fullName.split(' ')[0] ?? ''
  const address = clean(i?.businessAddress) || clean(src.address)
  const { city, state } = cityState(address)
  const years = yearsInBusiness(i?.yearStarted, now)
  const ownership =
    fullName && years
      ? `owned and operated by ${fullName} for ${years} years`
      : years
        ? `in business locally for ${years} years`
        : fullName
          ? `owned and operated by ${fullName}`
          : ''
  const cities = splitCities(clean(i?.cities))
  const serviceArea = cities.length > 1 ? `${cities.slice(0, -1).join(', ')} and ${cities[cities.length - 1]}` : (cities[0] ?? '')
  return {
    businessName,
    legalName: businessName,
    ein: clean(i?.ein),
    contactEmail: clean(i?.leadEmail) || clean(src.contactEmail),
    ownerFirstName,
    trade: '',
    city,
    state,
    ownership,
    serviceArea,
    address,
    domain: hostOnly(src.siteUrl) || hostOnly(i?.domainName) || hostOnly(i?.website) || hostOnly(src.website),
    phone: formatPhone(i?.customerPhone || src.contactPhone),
    promoLabel: seasonLabel(now),
    offer: '',
    offerBy: '',
    primaryCities: cities.length ? cities.slice(0, 2).join(' and ') : city,
  }
}

export type A2pGroup = 'brand' | 'campaign' | 'form' | 'workflow'

export type A2pField = {
  id: string
  group: A2pGroup
  label: string
  text: string
  /** The carrier registry's character limit for this field. */
  limit?: number
  note?: string
}

const BLANK = /\{\{([^}]+)\}\}/g

/** A value, or a highlighted blank when it's missing. */
const v = (value: string, label: string) => clean(value) || `{{${label}}}`

/** Labels still blank in a piece of copy. */
export function blanksIn(text: string): string[] {
  return [...text.matchAll(BLANK)].map((m) => m[1]).filter((b, i, all) => all.indexOf(b) === i)
}

/** The text as it goes into GHL: blanks become [LABEL]. */
export function forCopy(text: string): string {
  return text.replace(BLANK, (_m, label: string) => `[${label}]`)
}

/** Text split into plain runs and blanks, for rendering. */
export function segments(text: string): { text: string; blank: boolean }[] {
  const out: { text: string; blank: boolean }[] = []
  let last = 0
  for (const m of text.matchAll(BLANK)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index), blank: false })
    out.push({ text: `[${m[1]}]`, blank: true })
    last = m.index! + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), blank: false })
  return out
}

export function checkboxInformational(businessName: string): string {
  return `By checking this box, I agree to receive SMS text messages from ${v(businessName, 'BUSINESS NAME')} about my inquiry, estimates, appointments, and project updates. Msg frequency varies, typically 4-8 msgs/month. Msg & data rates may apply. Reply STOP to opt out, HELP for help. Consent is not a condition of purchase. See our Privacy Policy and Terms.`
}

export function checkboxMarketing(businessName: string): string {
  return `By checking this box, I also agree to receive occasional marketing and promotional SMS text messages from ${v(businessName, 'BUSINESS NAME')}, such as seasonal specials and discounts. Typically 1-2 msgs/month. Msg & data rates may apply. Reply STOP to opt out, HELP for help. Consent is not a condition of purchase.`
}

export function a2pFields(x: A2pInputs): A2pField[] {
  const B = v(x.businessName, 'BUSINESS NAME')
  const domain = v(x.domain, 'DOMAIN')
  const site = `https://${domain}`
  const phone = v(x.phone, 'PHONE')

  const article = /^[aeiou]/i.test(clean(x.trade)) ? 'an' : 'a'
  const intro = [
    `${B} is ${article} ${v(x.trade, 'TRADE')} in ${v(x.city, 'CITY')}, ${v(x.state, 'STATE')}`,
    clean(x.ownership) ? `, ${clean(x.ownership)}` : '',
    clean(x.serviceArea) ? `, serving ${clean(x.serviceArea).replace(/\.$/, '')}` : '',
    `. Address: ${v(x.address, 'STREET ADDRESS')}. Website: ${site}`,
  ].join('')

  const useCase = [
    intro,
    'We send text messages only to homeowners who have requested a quote or hired us, and who have given express consent. Messages are conversational and transactional, sent one to one, plus occasional promotional offers to customers who separately opted in. Marketing consent is collected separately from informational consent via its own optional checkbox on our forms.',
    'Message content includes: quote follow-up and estimate details, scheduling and appointment confirmations, reminders before a quote visit, crew arrival and project status updates, weather-related rescheduling, invoice and payment follow-up, and occasional seasonal promotions.',
    `Volume is low, typically 4 to 8 messages per recipient per month depending on whether a project is active, with marketing limited to 1 to 2 messages per month. Customers can reply STOP to opt out or HELP for assistance at any time. Message and data rates may apply. We do not purchase, rent, or import third-party lists. Every recipient has a direct prior relationship with the business. We do not sell or share phone numbers or consent with third parties. Full program details are published at ${site}/terms-of-service`,
  ].join('\n\n')

  const offer = `${clean(x.promoLabel) || 'Special'}: ${v(x.offer, 'OFFER')}${clean(x.offerBy) ? ` booked by ${clean(x.offerBy)}` : ''}.`
  const promo = `Hi [First Name], this is ${v(x.ownerFirstName, 'OWNER')} from ${B}. ${offer} Free written quotes in ${v(x.primaryCities, 'PRIMARY CITIES')}. Reply here, call ${phone}, or visit ${domain}/contact. Msg & data rates may apply. Reply STOP to opt out, HELP for help.`

  const transactional = `Hi [First Name], this is ${B} confirming your Free On-Site Estimate on [Date] at [Time] at [Address]. We'll call you at [Phone Number] when we're en route. Need to reschedule? Reply here or call ${phone}. Reply STOP to opt out, HELP for help.`

  const box1 = checkboxInformational(x.businessName)
  const box2 = checkboxMarketing(x.businessName)
  const optInFlow = `Contacts opt in through the quote request form on our website, available on the homepage at ${site} and the contact page at ${site}/contact. The same form appears on several service pages and is identical everywhere. The form collects marketing and informational consent separately, through two optional, unchecked checkboxes. The first reads: "${box1}" The second reads: "${box2}" The Privacy Policy and Terms of Service are hyperlinked directly below the checkboxes within the form, and in the footer of every page. Contacts may also opt in by texting our business number first, or by giving verbal consent during a consultation or phone call. Neither consent is required to request a quote or hire us. We do not purchase phone numbers or share numbers or consent with third parties. Privacy Policy: ${site}/privacy-policy. Terms: ${site}/terms-of-service.`

  return [
    { id: 'legal-name', group: 'brand', label: 'Legal business name', text: v(x.legalName, 'LEGAL NAME'), note: 'Must match the IRS EIN letter exactly, and the website must show the same business name.' },
    { id: 'ein', group: 'brand', label: 'EIN', text: v(x.ein, 'EIN') },
    { id: 'address', group: 'brand', label: 'Business address', text: v(x.address, 'STREET ADDRESS') },
    { id: 'website', group: 'brand', label: 'Website', text: site },
    { id: 'industry', group: 'brand', label: 'Industry', text: 'Construction', note: 'Works for every building trade: coatings, fencing, remodeling.' },
    { id: 'email', group: 'brand', label: 'Contact email', text: v(x.contactEmail, 'EMAIL'), note: 'Gmail is accepted, but an email on the business domain scores better.' },

    { id: 'use-case', group: 'campaign', label: 'Use case description', text: useCase, limit: 4096 },
    { id: 'promo-sample', group: 'campaign', label: 'Promotional / marketing sample message', text: promo, limit: 1024 },
    { id: 'transactional-sample', group: 'campaign', label: 'Transactional / informational sample message', text: transactional, limit: 1024 },
    { id: 'opt-in-flow', group: 'campaign', label: 'How do contacts opt in to messages?', text: optInFlow, limit: 2048, note: 'Quotes the checkbox text below. It must match the live form word for word.' },
    {
      id: 'opt-in-message',
      group: 'campaign',
      label: 'Opt-in message',
      text: `${B}: You're signed up for text updates about your quote, appointments and project. Msg frequency varies, typically a few msgs/month. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`,
    },

    { id: 'checkbox-1', group: 'form', label: 'Checkbox 1 — informational (optional, unchecked)', text: box1 },
    {
      id: 'checkbox-2',
      group: 'form',
      label: 'Checkbox 2 — marketing (optional, unchecked)',
      text: box2,
      note: 'Map it to its own custom field such as sms_marketing_consent. Promotional texts go only to contacts with it checked; sending offers on box 1 alone is a TCPA violation, not just an A2P problem. Put "Privacy Policy" and "Terms" links right below the boxes.',
    },

    {
      id: 'opt-in-marketing',
      group: 'workflow',
      label: 'Opt-in message — marketing variant (not submitted)',
      text: `${B}: You're signed up for text updates about your quote, appointments and project, plus occasional offers. Msg frequency varies, typically a few msgs/month. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`,
      note: 'In the confirmation workflow, branch on sms_marketing_consent: send this one when checkbox 2 was checked.',
    },
  ]
}

export const A2P_CHECKLIST: { id: string; text: string }[] = [
  { id: 'two-boxes', text: 'Two consent checkboxes on every form, both optional and unchecked: box 1 informational, box 2 marketing. One combined checkbox gets rejected.' },
  { id: 'right-name', text: 'Checkbox text, footer copyright, FAQ answers and schema markup name this company. Search the live pages for every other client’s brand name.' },
  { id: 'links-below', text: 'Privacy Policy and Terms are linked right below the checkboxes in the form, and in the footer of every page.' },
  { id: 'legal-live', text: 'Legal pages load at the exact URLs cited: right brand and phone, a “Last updated” date, and an SMS section in the Terms (message types, frequency, rates, STOP, HELP, carrier liability).' },
  { id: 'no-sharing', text: 'The Privacy Policy says mobile numbers and SMS consent are never sold or shared with third parties for marketing.' },
  { id: 'www', text: 'Every URL tested with and without www. Use the one that loads itself (no redirect to the homepage), everywhere. A redirect fails CTA verification (error 30909).' },
  { id: 'verbatim', text: 'The checkbox text quoted in the submission matches the live form word for word.' },
  { id: 'automation', text: 'The opt-in confirmation automation is live in GHL. Reviewers test-submit the form and expect the text.' },
  { id: 'legal-name', text: 'The brand’s legal name matches the EIN letter exactly, and the website shows the same business name.' },
]

export const A2P_REJECTIONS: { rejection: string; cause: string; fix: string }[] = [
  { rejection: '30909 CTA verification', cause: 'A submitted URL is dead, parked, the wrong domain, or redirects to the homepage (www vs non-www).', fix: 'Load every URL in a browser first; cite only URLs that resolve to themselves.' },
  { rejection: 'Marketing consent not separate', cause: 'One checkbox covering updates and offers.', fix: 'Split into two optional, unchecked checkboxes.' },
  { rejection: 'Checkbox optional pre-check failure', cause: 'A consent checkbox is set to Required in the form builder.', fix: 'Turn Required off. Consent can never be a condition of purchase.' },
  { rejection: 'Brand mismatch', cause: 'Footer, FAQ or consent text names a different company (template leftovers).', fix: 'Search the live pages for every other client brand name.' },
  { rejection: 'Unverifiable CTA language', cause: 'The submission quotes checkbox text that differs from the live form.', fix: 'Copy the live form text into the submission verbatim.' },
]

export const A2P_DEPRECATED: string[] = [
  '“Required, non-pre-ticked checkbox”. Consent must be optional; “required” is a rejection trigger.',
  '“Marketing and non-marketing text messages” in one consent sentence. The types must be consented to separately.',
  'A “Financial Content Disclosure” paragraph. Unnecessary for home services and invites extra scrutiny.',
  'Any domain taken from an intake form without loading it in a browser first.',
]
