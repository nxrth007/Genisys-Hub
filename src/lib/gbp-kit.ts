import { formatPhone, hostOnly, splitCities } from './a2p'
import { inferTrade } from './trade'

/**
 * Google Business Profile setup kit for a client who doesn't have one.
 *
 * Google gives no way to finish a profile without the owner: every new
 * profile is verified by the business itself (these days mostly a short
 * video). What the Hub can do is everything around that: fill in exactly
 * what the create form asks for from the onboarding answers and the SEO
 * engine's business facts, write the owner a plain checklist, and keep
 * after it until the profile is verified. Client-safe (no database).
 *
 * Blanks are marked ⟦LABEL⟧ like the Automation Copy board and copy as [LABEL].
 */

export type GbpInputs = {
  businessName: string
  primaryCategory: string
  /** Up to 9 more, one per line. */
  extraCategories: string
  /** 'address' when customers can visit or the address is public; 'service_area' to hide it. */
  locationMode: 'address' | 'service_area'
  address: string
  /** One per line. Google wants cities or ZIP codes, never whole states. */
  serviceAreas: string
  phone: string
  website: string
  hours: string
  /** One per line. */
  services: string
  description: string
  /** The person who verifies, and whose Google account becomes the primary owner. */
  ownerFirstName: string
  ownerEmail: string
  ownerPhone: string
}

export const GBP_INPUT_KEYS = [
  'businessName',
  'primaryCategory',
  'extraCategories',
  'locationMode',
  'address',
  'serviceAreas',
  'phone',
  'website',
  'hours',
  'services',
  'description',
  'ownerFirstName',
  'ownerEmail',
  'ownerPhone',
] as const satisfies readonly (keyof GbpInputs)[]

export type GbpSource = {
  name: string
  contactName: string | null
  contactEmail: string | null
  contactPhone: string | null
  siteUrl: string | null
  website: string | null
  intake: {
    fullName: string | null
    businessName: string | null
    businessAddress: string | null
    customerPhone: string | null
    leadEmail: string | null
    cities: string | null
    mainServices: string | null
    aboutBusiness: string | null
    whyChooseYou: string | null
    yearStarted: string | null
  } | null
  /** The SEO engine's business facts, when the client has an SEO site. */
  facts: {
    businessName?: string
    trade?: string
    primaryCity?: string
    state?: string
    serviceAreas?: string[]
    services?: { name: string }[]
    phone?: string | null
    email?: string | null
    address?: string | null
    hiddenAddress?: boolean
    owner?: string | null
    established?: number | null
    insurance?: string | null
    license?: string | null
    hours?: string | null
    differentiators?: string[]
  } | null
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

/** The engine's trade phrases → Google Business Profile category names. */
const CATEGORY_FOR: Record<string, string[]> = {
  'roofing contractor': ['Roofing contractor'],
  'siding contractor': ['Siding contractor'],
  'gutter contractor': ['Gutter cleaning service'],
  'concrete contractor': ['Concrete contractor'],
  'masonry contractor': ['Mason'],
  'paving contractor': ['Paving contractor'],
  'painting contractor': ['Painter'],
  'drywall contractor': ['Drywall contractor'],
  'fence contractor': ['Fence contractor'],
  'deck builder': ['Deck builder'],
  plumber: ['Plumber'],
  electrician: ['Electrician'],
  'HVAC contractor': ['HVAC contractor'],
  'landscaping company': ['Landscaper'],
  'tree service': ['Tree service'],
  'remodeling contractor': ['Remodeler'],
  'flooring contractor': ['Flooring contractor'],
  'window and door contractor': ['Window installation service'],
  'garage door company': ['Garage door supplier'],
  'pressure washing company': ['Pressure washing service'],
  'cleaning company': ['House cleaning service'],
  'pool contractor': ['Swimming pool contractor'],
  'solar installer': ['Solar energy company'],
  'insulation contractor': ['Insulation contractor'],
  'pest control company': ['Pest control service'],
  'moving company': ['Moving company'],
  'junk removal company': ['Junk removal service'],
  'excavation contractor': ['Excavating contractor'],
  'welding and fabrication shop': ['Welder'],
  'cabinet maker': ['Cabinet maker'],
  'countertop installer': ['Countertop store'],
  'waterproofing contractor': ['Waterproofing service'],
  'septic contractor': ['Septic system service'],
  'handyman service': ['Handyman/Handywoman/Handyperson'],
  'carpentry contractor': ['Carpenter'],
  'home builder': ['Home builder'],
  'general contractor': ['General contractor'],
}

/** Service words that add a more specific category. */
const SERVICE_CATEGORIES: [RegExp, string][] = [
  [/\bkitchen/i, 'Kitchen remodeler'],
  [/\bbath(room)?/i, 'Bathroom remodeler'],
  [/\bpaver|patio/i, 'Paving contractor'],
  [/\bepoxy|garage floor|floor coating/i, 'Flooring contractor'],
  [/\blawn|mowing/i, 'Lawn care service'],
  [/\bpressure wash|power wash|driveway clean/i, 'Pressure washing service'],
  [/\bfloor/i, 'Flooring contractor'],
  [/\bpaint/i, 'Painter'],
  [/\broof/i, 'Roofing contractor'],
  [/\bfenc/i, 'Fence contractor'],
  [/\bconcrete/i, 'Concrete contractor'],
]

/** Primary first, then up to four more, from the trade and the services list. */
export function suggestCategories(trade: string, services: string[], extra: { businessName: string; about: string }): string[] {
  const out: string[] = []
  const add = (c: string) => {
    if (c && !out.some((x) => x.toLowerCase() === c.toLowerCase())) out.push(c)
  }
  const guess = inferTrade({ businessName: extra.businessName, mainServices: services.join(', '), aboutBusiness: extra.about })
  const fromPhrase = (p: string) => {
    const hits: string[] = []
    // "masonry and concrete contractor" → both.
    for (const [phrase, cats] of Object.entries(CATEGORY_FOR)) {
      if (p === phrase.toLowerCase() || p.includes(phrase.toLowerCase().replace(/ contractor| company| service/, ''))) hits.push(...cats)
    }
    return hits
  }
  // Primary: the recorded trade, else the best guess. Then what each listed service says, then the other guesses.
  fromPhrase(clean(trade).toLowerCase()).forEach(add)
  if (!out.length && guess.candidates[0]) fromPhrase(guess.candidates[0].phrase).forEach(add)
  for (const s of services) for (const [re, c] of SERVICE_CATEGORIES) if (re.test(s)) add(c)
  for (const c of guess.candidates.slice(0, 2)) fromPhrase(c.phrase).forEach(add)
  return out.slice(0, 6)
}

const titleCity = (c: string) => c.replace(/\b\w/g, (m) => m.toUpperCase())

/** Everything the onboarding answers and the SEO facts can fill in. */
export function gbpPrefill(src: GbpSource): GbpInputs {
  const i = src.intake
  const f = src.facts
  const businessName = clean(f?.businessName) || clean(i?.businessName) || clean(src.name)
  const fullName = clean(i?.fullName) || clean(src.contactName) || clean(f?.owner)
  const services = f?.services?.length ? f.services.map((s) => clean(s.name)).filter(Boolean) : splitCities(clean(i?.mainServices))
  const areas = f?.serviceAreas?.length ? f.serviceAreas.map(clean).filter(Boolean) : splitCities(clean(i?.cities)).map(titleCity)
  const address = clean(f?.address) || clean(i?.businessAddress)
  const categories = suggestCategories(clean(f?.trade), services, { businessName, about: clean(i?.aboutBusiness) })
  const website = clean(src.siteUrl) || clean(src.website)
  return {
    businessName,
    primaryCategory: categories[0] ?? '',
    extraCategories: categories.slice(1).join('\n'),
    locationMode: f?.hiddenAddress || !address ? 'service_area' : 'address',
    address,
    serviceAreas: areas.join('\n'),
    // The profile's number must match the site exactly: the SEO facts hold what the site shows.
    phone: formatPhone(f?.phone || i?.customerPhone || src.contactPhone),
    website: website ? `https://${hostOnly(website)}` : '',
    hours: clean(f?.hours),
    services: services.join('\n'),
    description: describe({
      businessName,
      // A noun for "is a …": the engine's trade when it reads as one ("roofing contractor"), else the primary category.
      trade: /(contractor|company|builder|installer|service|shop|maker|plumber|electrician|painter|remodeler)$/i.test(clean(f?.trade))
        ? clean(f?.trade).toLowerCase()
        : (categories[0] ?? '').toLowerCase(),
      city: clean(f?.primaryCity),
      state: clean(f?.state),
      areas,
      services,
      owner: fullName,
      established: f?.established ?? null,
      licensed: !!(clean(f?.license) || clean(f?.insurance)),
      differentiators: (f?.differentiators ?? []).map(clean).filter(Boolean),
    }),
    ownerFirstName: fullName.split(' ')[0] ?? '',
    ownerEmail: clean(i?.leadEmail) || clean(src.contactEmail) || clean(f?.email),
    ownerPhone: formatPhone(i?.customerPhone || src.contactPhone),
  }
}

/** Google's limit for the "from the business" description. */
export const GBP_DESCRIPTION_LIMIT = 750

/**
 * A plain description from facts only. Google's rules: no links, no phone
 * numbers, no prices or promotions, no all-caps — so none of those here.
 */
function describe(d: {
  businessName: string
  trade: string
  city: string
  state: string
  areas: string[]
  services: string[]
  owner: string
  established: number | null
  licensed: boolean
  differentiators: string[]
}): string {
  if (!d.businessName) return ''
  const article = /^[aeiou]/i.test(d.trade) ? 'an' : 'a'
  const where = d.city ? ` based in ${d.city}${d.state ? `, ${d.state}` : ''}` : ''
  const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] ?? '')
  const parts = [
    `${d.businessName} is ${d.trade ? `${article} ${d.trade}` : 'a local contractor'}${where}${d.established ? `, in business since ${d.established}` : ''}.`,
    d.services.length ? `We handle ${list(d.services.slice(0, 6).map((s) => s.toLowerCase()))}.` : '',
    d.areas.length > 1 ? `We serve homeowners in ${list(d.areas.slice(0, 6))}.` : '',
    d.owner ? `The business is owned and run by ${d.owner}, who works with every customer directly.` : '',
    d.licensed ? 'Licensed and insured.' : '',
    ...d.differentiators.slice(0, 2).map((x) => (/[.!?]$/.test(x) ? x : `${x}.`)),
    'Contact us for a free estimate.',
  ].filter(Boolean)
  let out = ''
  for (const p of parts) {
    if ((out ? `${out} ${p}` : p).length > GBP_DESCRIPTION_LIMIT) break
    out = out ? `${out} ${p}` : p
  }
  return out
}

// ---------------------------------------------------------------------------
// The kit and the messages
// ---------------------------------------------------------------------------

const v = (value: string, label: string) => clean(value) || `⟦${label}⟧`

export type GbpField = { id: string; label: string; text: string; note?: string; limit?: number; mono?: boolean }

/** In the order Google's create form asks for them (business.google.com/create). */
export function gbpFields(x: GbpInputs): GbpField[] {
  const lines = (s: string) => s.split('\n').map(clean).filter(Boolean)
  return [
    {
      id: 'name',
      label: 'Business name',
      text: v(x.businessName, 'BUSINESS NAME'),
      note: 'Exactly the real-world name on their truck, invoices and site. No city or service words added: Google suspends profiles for keyword-stuffed names.',
    },
    {
      id: 'category',
      label: 'Primary category',
      text: v(x.primaryCategory, 'PRIMARY CATEGORY'),
      note: 'Pick the closest match from Google’s own list as you type; it must be one of Google’s categories.',
    },
    ...(lines(x.extraCategories).length
      ? [{ id: 'extra', label: 'Additional categories (after the profile is created, under Edit profile)', text: lines(x.extraCategories).join('\n') }]
      : []),
    x.locationMode === 'address'
      ? {
          id: 'location',
          label: 'Do you want to add a location customers can visit? Yes, this address',
          text: v(x.address, 'STREET ADDRESS'),
          note: 'Must match the address on the site exactly. Choose “No” instead if customers never come to it.',
        }
      : {
          id: 'location',
          label: 'Location customers can visit? No. Service areas:',
          text: lines(x.serviceAreas).join('\n') || '⟦SERVICE AREAS⟧',
          note: 'Cities or ZIP codes only, up to 20. Google removes whole states. The address stays hidden from the public.',
        },
    {
      id: 'phone',
      label: 'Phone',
      text: v(x.phone, 'PHONE'),
      note: 'The same number the website shows (its GHL number), so Google sees one consistent business. Add the owner’s own line as an additional number if they want.',
      mono: true,
    },
    { id: 'website', label: 'Website', text: v(x.website, 'WEBSITE'), mono: true },
    ...(clean(x.hours) ? [{ id: 'hours', label: 'Hours', text: clean(x.hours) }] : []),
    ...(lines(x.services).length ? [{ id: 'services', label: 'Services (Edit profile → Services)', text: lines(x.services).join('\n') }] : []),
    {
      id: 'description',
      label: 'Business description (Edit profile → Description)',
      text: v(x.description, 'DESCRIPTION'),
      limit: GBP_DESCRIPTION_LIMIT,
      note: 'No links, phone numbers, prices or offers: Google rejects descriptions with them.',
    },
    {
      id: 'owner',
      label: 'Give the client ownership (Settings → People and access → Add)',
      text: v(x.ownerEmail, 'OWNER EMAIL'),
      note: 'Add this email as Primary owner. Genisys stays on as a manager. The client verifies from this Google account.',
      mono: true,
    },
  ]
}

/** The first text to the owner: what Google needs from them and how to do it. Plain GSM so it stays cheap. */
export function verificationMessage(x: GbpInputs): string {
  const first = clean(x.ownerFirstName) || 'there'
  const B = v(x.businessName, 'BUSINESS NAME')
  const email = v(x.ownerEmail, 'OWNER EMAIL')
  return [
    `Hi ${first}, it's Genisys. We set up a Google Business Profile for ${B} so you show up on Google Maps and local search.`,
    '',
    'Google needs you to verify it (about 5 minutes):',
    `1. On your phone, go to business.google.com and sign in with ${email}`,
    '2. Tap Verify and choose Video',
    '3. Record one unbroken clip showing your business name (truck, sign or paperwork), your tools or equipment, and you at work or opening your shop',
    '',
    'Reply here if you get stuck and we will walk you through it.',
  ].join('\n')
}

/** Follow-up while the profile still isn't done. With the client's setup page link when they were sent one. */
export function reminderMessage(x: GbpInputs, setupLink?: string | null): string {
  const first = clean(x.ownerFirstName) || 'there'
  return setupLink
    ? `Hi ${first}, quick reminder from Genisys: your Google Business Profile for ${v(x.businessName, 'BUSINESS NAME')} isn't set up yet. Every answer is filled in for you here, it takes about 10 minutes: ${setupLink}`
    : `Hi ${first}, quick reminder from Genisys: your Google Business Profile for ${v(x.businessName, 'BUSINESS NAME')} still needs the short verification video. Go to business.google.com, tap Verify, then Video. Reply here if you want help.`
}

/** The text with the client's setup page: they create the profile themselves, from our answers. Plain characters only. */
export function instructionsText(x: GbpInputs, setupLink: string): string {
  const first = clean(x.ownerFirstName) || 'there'
  return `Hi ${first}, it's Genisys. Next step for ${v(x.businessName, 'BUSINESS NAME')}: getting you on Google Maps with a Google Business Profile. It takes about 10 minutes and we filled in every answer for you. Start here: ${setupLink}`
}

/** The same as an email (markdown; the Hub's mailer turns it into HTML). */
export function instructionsEmail(x: GbpInputs, setupLink: string): { subject: string; body: string } {
  const first = clean(x.ownerFirstName) || 'there'
  const B = v(x.businessName, 'BUSINESS NAME')
  return {
    subject: `Set up your Google Business Profile for ${B}`,
    body: [
      `Hi ${first},`,
      '',
      `The next step for ${B} is a Google Business Profile. It's what puts you on Google Maps and in the local results when people search for your services nearby, and it's where customers leave reviews.`,
      '',
      'It takes about 10 minutes, and we have already written every answer Google asks for. Open your setup page and copy each one in:',
      '',
      `**[Open your Google Business Profile setup page](${setupLink})**`,
      '',
      'The page walks you through it:',
      '',
      '1. Start the profile at business.google.com/create, signed in with your own Google account, so you own it.',
      '2. Copy in each answer we prepared: your business name, category, service areas, phone, website, services and description.',
      '3. Add Genisys as a manager, so we can keep it up to date for you.',
      '4. Verify the profile: Google usually asks for a short video showing your business.',
      '5. Paste your new profile link at the bottom of the page, so we know it is done.',
      '',
      'If you get stuck at any step, reply to this email or text us and we will walk you through it.',
      '',
      'Genisys',
    ].join('\n'),
  }
}

export const GBP_STATUSES = ['needed', 'existing', 'created', 'verifying', 'verified', 'has_profile'] as const
export type GbpStatus = (typeof GBP_STATUSES)[number]

export const GBP_STATUS_LABEL: Record<GbpStatus, string> = {
  needed: 'Needs a profile',
  existing: 'Existing listing to claim',
  created: 'Created, ownership being set',
  verifying: 'Waiting on the client',
  verified: 'Verified',
  has_profile: 'Client already has one',
}

/** What the onboarding form's "Do you have a Google Business Profile?" answer means. */
export function intakeSaysProfile(answer: string | null | undefined): 'yes' | 'no' | null {
  const a = clean(answer).toLowerCase()
  if (!a) return null
  if (/^(no|nope|n)\b|don'?t|do not|not yet|none/.test(a)) return 'no'
  if (/^(yes|yeah|yep|y)\b|have one|already/.test(a)) return 'yes'
  return null
}
