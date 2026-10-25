import { a2pPrefill, checkboxInformational, checkboxMarketing, forCopy, formatPhone, type A2pSource } from './a2p'
import { parseUsAddress } from './address-parse'
/**
 * Toll-free verification copy for a client: what GHL's form asks for (the
 * number's "Verification Required" link under Settings → Phone System →
 * Manage Numbers), in its order, filled in from the onboarding answers.
 *
 * Toll-free verification is free and needs no EIN, where A2P has brand,
 * vetting and monthly campaign fees. GHL files it with Twilio, so the
 * wording follows what Twilio took for Forte's number through Hell-level
 * (src/lib/hl/verification.ts) and GHL's own guide. Blanks work as on the
 * A2P board: {{LABEL}} until filled in, copied as [LABEL].
 */

export type TollFreeInputs = {
  businessName: string
  legalName: string
  ein: string
  trade: string
  contactFirstName: string
  contactLastName: string
  contactEmail: string
  contactPhone: string
  street: string
  city: string
  state: string
  zip: string
  domain: string
  phone: string
  /** "yes" when the site's forms have the separate marketing checkbox. */
  promos: string
}

export const TOLL_FREE_INPUT_KEYS = [
  'businessName',
  'legalName',
  'ein',
  'trade',
  'contactFirstName',
  'contactLastName',
  'contactEmail',
  'contactPhone',
  'street',
  'city',
  'state',
  'zip',
  'domain',
  'phone',
  'promos',
] as const satisfies readonly (keyof TollFreeInputs)[]

/** The registry's limits (Twilio said "Invalid use case summary" at 569 characters for Forte). */
export const TOLL_FREE_LIMITS = { useCase: 500, sample: 1000 } as const

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()
const v = (value: string, label: string) => clean(value) || `{{${label}}}`
export const isYes = (s: string | null | undefined) => clean(s).toLowerCase() === 'yes'

/** "PO Box 12", "P.O. Box", "Post Office Box", "POB 5", "Box 45": a mailbox, not where the business is. */
export function isPoBox(s: string | null | undefined): boolean {
  return /\b(?:p\.?\s*o\.?\s*(?:box|b\b)|post\s+office\s+box|pob\b|box\s+#?\d+)/i.test(s ?? '')
}

/** Everything the onboarding answers can fill in. */
export function tollFreePrefill(src: A2pSource, now = new Date()): TollFreeInputs {
  const a = a2pPrefill(src, now)
  const fullName = clean(src.intake?.fullName) || clean(src.contactName)
  const [first = '', ...rest] = fullName.split(' ')
  const addr = parseUsAddress(a.address)
  return {
    businessName: a.businessName,
    legalName: a.legalName,
    ein: a.ein,
    trade: a.trade,
    contactFirstName: first,
    contactLastName: rest.join(' '),
    contactEmail: a.contactEmail,
    contactPhone: formatPhone(src.contactPhone || src.intake?.customerPhone),
    street: addr.street,
    city: addr.city || a.city,
    state: addr.stateName || a.state,
    zip: addr.zip,
    domain: a.domain,
    phone: a.phone,
    promos: 'yes',
  }
}

export type TollFreeGroup = 'business' | 'location' | 'messaging' | 'registration' | 'form'

export type TollFreeField = {
  id: string
  group: TollFreeGroup
  label: string
  text: string
  limit?: number
  note?: string
}

/** How the business texts, in the registry's 500 characters: the first wording that fits. */
function describeUseCase(x: TollFreeInputs, B: string, site: string): string {
  const promos = isYes(x.promos)
  const trade = v(x.trade, 'TRADE')
  const article = /^[aeiou]/i.test(clean(x.trade)) ? 'an' : 'a'
  const where = `${v(x.city, 'CITY')}, ${v(x.state, 'STATE')}`
  const promo = promos
    ? 'Promotions (1-2 a month) go only to people who also tick the separate, optional marketing checkbox.'
    : 'It sends no marketing or promotional texts.'
  // GHL's guide: say who's texted, why, where they opted in, and how texts are sent.
  const versions = [
    `${B} is ${article} ${trade} in ${where}. It texts homeowners who request a quote on its website's form (${site}) and tick its optional, unchecked consent box, linked to its Privacy Policy and Terms. Texts are about their request (estimate, appointments, reminders, project updates), sent one to one by staff and by automatic follow-ups. ${promo} Reply STOP to opt out, HELP for help.`,
    `${B}, ${article} ${trade} in ${where}, texts homeowners who request a quote on its website's form (${site}) and tick its optional, unchecked consent checkbox, linked to its Privacy Policy and Terms. Texts cover their estimate, appointments and project updates, one to one from staff and automatic follow-ups. ${promo} Reply STOP to opt out.`,
    `${B} texts people who request a quote on its website's form and tick its optional, unchecked consent checkbox, with links to its Privacy Policy and Terms. Texts cover the estimate, appointments and project updates. ${promos ? 'Promotions (1-2 a month) go only to those who tick the separate marketing checkbox.' : 'No marketing texts.'} Reply STOP to opt out.`,
  ]
  return versions.find((t) => forCopy(t).length <= TOLL_FREE_LIMITS.useCase) ?? versions[versions.length - 1]
}

export function tollFreeFields(x: TollFreeInputs): TollFreeField[] {
  const promos = isYes(x.promos)
  const B = v(x.businessName, 'BUSINESS NAME')
  const legal = v(x.legalName || x.businessName, 'LEGAL NAME')
  const site = `https://${v(x.domain, 'DOMAIN')}`
  const phone = v(x.phone, 'PHONE')
  const ein = clean(x.ein).replace(/\D/g, '')
  const poBox = isPoBox(x.street)
  const dba = clean(x.businessName) && clean(x.legalName) && clean(x.businessName).toLowerCase() !== clean(x.legalName).toLowerCase()

  const transactional = `${B}: Hi [First Name], thanks for your quote request! Your free estimate is booked for [Date] at [Time]. Questions or need to reschedule? Reply here or call ${phone}. Reply STOP to opt out.`
  const promo = `${B}: Hi [First Name], our [Season] special is on: [Offer] on projects booked by [Date]. Reply here or call ${phone} for a free quote. Reply STOP to opt out.`

  const fields: TollFreeField[] = [
    {
      id: 'legal-name',
      group: 'business',
      label: 'Legal Entity Name',
      text: legal,
      note: 'GHL wants the name the website shows. With an EIN it must also match the IRS letter, so the site should show this name too (the footer’s © line works).',
    },
    { id: 'website', group: 'business', label: 'Website URL', text: site, note: 'The www or no-www version that loads itself.' },
    { id: 'first-name', group: 'business', label: 'First name', text: v(x.contactFirstName, 'FIRST NAME') },
    { id: 'last-name', group: 'business', label: 'Last name', text: v(x.contactLastName, 'LAST NAME') },
    {
      id: 'email',
      group: 'business',
      label: 'Email',
      text: v(x.contactEmail, 'EMAIL'),
      note: 'Best on the business’s own domain. A Gmail passes only if the website shows it as the business’s email (rejection 30482).',
    },
    { id: 'phone', group: 'business', label: 'Phone number', text: v(x.contactPhone, 'CONTACT PHONE'), note: 'Country code: +1.' },

    { id: 'country', group: 'location', label: 'Country', text: 'United States' },
    { id: 'state', group: 'location', label: 'State', text: v(x.state, 'STATE') },
    {
      id: 'street',
      group: 'location',
      label: 'Address Line 1',
      text: v(poBox ? '' : x.street, poBox ? 'STREET ADDRESS, NOT THE PO BOX' : 'STREET ADDRESS'),
      note: 'Where the business actually is. GHL asks for the physical location; a PO box or an address Twilio can’t match gets rejected (30451).',
    },
    { id: 'city', group: 'location', label: 'City', text: v(x.city, 'CITY') },
    { id: 'zip', group: 'location', label: 'Postal / ZIP code', text: v(x.zip, 'ZIP') },

    { id: 'volume', group: 'messaging', label: 'Estimated Monthly Volume', text: '1,000', note: 'The smallest option that covers them; a local contractor sends well under 1,000 texts a month.' },
    { id: 'opt-in-type', group: 'messaging', label: 'Opt-In Type', text: 'Web Form' },
    {
      id: 'categories',
      group: 'messaging',
      label: 'Use Case Category',
      text: promos ? 'Customer Care, Marketing' : 'Customer Care',
      note: promos ? 'Tick both. Marketing is there because the forms have the separate marketing checkbox.' : 'Only Customer Care: promotions are off, so no Marketing.',
    },
    { id: 'use-case', group: 'messaging', label: 'Use Case Description', text: describeUseCase(x, B, site), limit: TOLL_FREE_LIMITS.useCase },
    {
      id: 'sample',
      group: 'messaging',
      label: 'Message Content',
      text: promos ? `${transactional}\n\n${promo}` : transactional,
      limit: TOLL_FREE_LIMITS.sample,
      note: 'Each sample starts with the business name and ends with the opt-out. Missing either is a common rejection.',
    },

    ...(dba ? [{ id: 'dba', group: 'registration' as const, label: 'DBA', text: B, note: 'The name it goes by, since it differs from the legal name.' }] : []),
    {
      id: 'entity-type',
      group: 'registration',
      label: 'Entity type',
      text: ein.length === 9 ? 'Private for-profit company' : 'Sole proprietor',
      note: ein.length === 9 ? 'An LLC or corporation with an EIN. Pick GHL’s closest option.' : 'No EIN on file. GHL doesn’t need one for toll-free.',
    },
    ...(ein.length === 9
      ? [
          { id: 'reg-authority', group: 'registration' as const, label: 'Registration authority', text: 'EIN' },
          { id: 'reg-number', group: 'registration' as const, label: 'Registration number', text: ein, note: 'The 9 digits. Add the dash (12-3456789) if GHL asks for it.' },
          { id: 'reg-country', group: 'registration' as const, label: 'Registration country', text: 'United States' },
        ]
      : []),

    { id: 'checkbox-1', group: 'form', label: 'Checkbox 1: texts about their request (optional, unchecked)', text: checkboxInformational(x.businessName) },
    ...(promos
      ? [
          {
            id: 'checkbox-2',
            group: 'form' as const,
            label: 'Checkbox 2: marketing (optional, unchecked)',
            text: checkboxMarketing(x.businessName),
            note: 'Its own box and its own custom field. Promotions go only to contacts who ticked it.',
          },
        ]
      : []),
    {
      id: 'opt-in-confirmation',
      group: 'form',
      label: 'Confirmation text (the form’s workflow sends it)',
      text: `${B}: Thanks for reaching out! We'll text you about your request. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`,
      note: 'Not part of the submission. Reviewers may fill in the form and expect this text.',
    },
  ]
  return fields
}

export const TOLL_FREE_CHECKLIST: { id: string; text: string }[] = [
  { id: 'number', text: 'The toll-free number is in the client’s GHL sub-account. Its “Verification Required” link (Settings → Phone System → Manage Numbers) opens the form.' },
  { id: 'optional', text: 'The quote form’s consent checkbox is optional and unchecked. Set to Required, it’s rejected (30505). With promotions on, the separate marketing checkbox is there too.' },
  { id: 'links', text: 'Privacy Policy and Terms are linked right by the checkboxes and in the footer, and both pages load.' },
  { id: 'same-details', text: 'The website shows the same business name, phone and email as the submission (footer and contact page).' },
  { id: 'street', text: 'The address is the business’s physical street address, not a PO box, and matches Google and the website.' },
  { id: 'screenshot', text: 'The opt-in screenshot shows the whole form, and its Media Storage link opens in a private window.' },
  { id: 'www', text: 'The website URL loads itself, with or without www as submitted (no redirect).' },
  { id: 'automation', text: 'The form’s confirmation text is live in GHL.' },
]

export const TOLL_FREE_REJECTIONS: { rejection: string; cause: string; fix: string }[] = [
  { rejection: '30445 Couldn’t validate business', cause: 'The name, address or website don’t match a real business, or an agency’s details went in.', fix: 'Use the client’s own name, address and site, as the website shows them.' },
  { rejection: '30451 Address invalid', cause: 'Missing or wrong street, city, state or ZIP, or a PO box.', fix: 'Enter the full physical street address.' },
  { rejection: '30482 Business email', cause: 'A free email (Gmail, Yahoo) that the website doesn’t show.', fix: 'Use an email on the business’s domain, or put the Gmail on the website first.' },
  { rejection: '30505 Opt-in must be optional', cause: 'The consent checkbox is set to Required.', fix: 'Turn Required off in the form builder.' },
  { rejection: '30509 Opt-in URL not accessible', cause: 'The screenshot link needs a login or is dead.', fix: 'Media Storage → Get Link, then test it in a private window.' },
  { rejection: 'Use case or samples don’t match', cause: 'Samples without the business name or STOP, or promotions sent without Marketing ticked.', fix: 'Name the business first and end with the opt-out; tick Marketing when promotions are on.' },
]
