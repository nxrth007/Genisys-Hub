/**
 * Tidying a client's onboarding answers right after they submit (Alex, 2026-11-14: "there needs to be
 * some AI agent that will check the answers and format everything properly after a client submits").
 * Concrete masonry's toll-free filing stopped on "13982 Sheldon rd": a street with no city, state or ZIP.
 *
 * Claude reads every answer and says what each should be: swapped name and address boxes put back, one
 * owner's name, phones as (216) 333-5885, an EIN as 12-3456789, cities as "Austin TX", and where a street
 * with no town most likely is. An answer is kept only when it passes the checks here, and a town or ZIP
 * Claude came up with is never taken on its word: the address map has to find that house number on that
 * street there (./intake-tidy.ts). Pure (tests load it).
 */
import { STATE_CODE_TO_NAME, STATE_NAME_TO_CODE } from './address'
import { isPoBox, looksLikeAddress, parseUsAddress, streetIn } from './address-parse'

/** The answers the tidy may rewrite (ClientIntake columns). */
export const TIDY_FIELDS = ['businessName', 'fullName', 'businessContact', 'businessAddress', 'customerPhone', 'areaCode', 'timeZone', 'leadEmail', 'cities', 'website', 'ein'] as const
export type TidyField = (typeof TIDY_FIELDS)[number]

/** Answers Claude reads for context only: a town or the business name can turn up in any of them. */
export const CONTEXT_FIELDS = ['aboutBusiness', 'mainServices', 'licenseInfo', 'googleProfileLink', 'domainName', 'socialLinks', 'reviewLinks', 'yearStarted'] as const
type ContextField = (typeof CONTEXT_FIELDS)[number]

export type TidyAnswers = Partial<Record<TidyField | ContextField, string | null>>

/** The form's questions, so Claude reads each answer as the client saw it. */
const QUESTIONS: Record<TidyField | ContextField, string> = {
  businessName: 'Legal Business Name',
  fullName: 'Full Name',
  businessContact: 'Business Contact Information (the owner’s direct phone)',
  businessAddress: 'Business Address',
  customerPhone: 'Best phone number for customers to reach the business',
  areaCode: 'Area code wanted for a local number',
  timeZone: 'Time Zone',
  leadEmail: 'Email',
  cities: 'Cities you service',
  website: 'Website',
  ein: 'EIN',
  aboutBusiness: 'About the business',
  mainServices: 'Main services',
  licenseInfo: 'License information',
  googleProfileLink: 'Google Business Profile link',
  domainName: 'Their own domain',
  socialLinks: 'Social media pages',
  reviewLinks: 'Review sites',
  yearStarted: 'Year started',
}

export const TIME_ZONES = ['Eastern', 'Central', 'Mountain', 'Arizona', 'Pacific', 'Alaska', 'Hawaii'] as const

/** What Claude says each answer should be ("" or [] where the answers don't say). */
export type AiTidy = {
  businessName: string
  ownerName: string
  ownerPhone: string
  customerPhone: string
  email: string
  website: string
  street: string
  city: string
  state: string
  zip: string
  townGuesses: string[]
  serviceCities: string[]
  timeZone: string
  ein: string
  areaCode: string
  notes: string[]
  doubts: string[]
}

const text = (description: string) => ({ type: 'string', description })
const list = (description: string) => ({ type: 'array', items: { type: 'string' }, description })

/** Structured output: Claude's answer always has every field. */
export const AI_TIDY_SCHEMA = {
  type: 'object',
  properties: {
    businessName: text('The legal business name, as on their IRS EIN letter. Never an address, phone, email or website.'),
    ownerName: text('One person’s first and last name: the owner or main contact.'),
    ownerPhone: text('The owner’s direct phone, 10 digits.'),
    customerPhone: text('The phone customers should call, 10 digits.'),
    email: text('One email address, lower case.'),
    website: text('Their current website as https://…, or "".'),
    street: text('House number and street, exactly as typed apart from capitalisation; "" for a PO box or none.'),
    city: text('City, only if the client typed it somewhere on the form.'),
    state: text('Two-letter state code, only if the client typed the state (or a city that settles it) somewhere on the form.'),
    zip: text('5-digit ZIP, only if the client typed it.'),
    townGuesses: list('Up to 3 "City, ST" places where the street most likely is, best first, when the address has no town. [] otherwise.'),
    serviceCities: list('The places they serve, each "City ST" (or "Name County ST").'),
    timeZone: { type: 'string', enum: [...TIME_ZONES, ''], description: 'Their time zone, from their answer, else their state.' },
    ein: text('9 digits as 12-3456789, or "".'),
    areaCode: text('3-digit area code for a local number, or "".'),
    notes: list('Each change worth telling the team, one short plain-English sentence each. Not formatting-only changes.'),
    doubts: list('Anything a person should check or ask the client, one short sentence each.'),
  },
  required: ['businessName', 'ownerName', 'ownerPhone', 'customerPhone', 'email', 'website', 'street', 'city', 'state', 'zip', 'townGuesses', 'serviceCities', 'timeZone', 'ein', 'areaCode', 'notes', 'doubts'],
  additionalProperties: false,
}

export const TIDY_SYSTEM = `You tidy the answers a small home-services business (a contractor: roofing, concrete, cleaning, landscaping and so on) gave on Genisys's onboarding form. The agency fills the business's profile from them and files the business's texting registration with the phone carriers, so every field has to be right and in the right place.

Clients rush this form. They put the address in the business-name box and the name in the address box, type two phone numbers in one box, write both owners' names, give a street with no town, or type "N/A". Say what each answer should be, from what they actually wrote anywhere on the form. Never invent: leave a field "" (or a list []) when the answers don't say it.

- businessName: the legal business name, with LLC or Inc as they wrote it. Never an address, phone, email or website. If the name box holds an address and another box holds the name, put them back. Fix only obvious capitalisation (all lower case or ALL CAPS) and stray spaces; keep their wording.
- ownerName: one person's first and last name (the owner or main contact), capitalised. If two people are named, take the first and say so in notes.
- ownerPhone and customerPhone: 10 digits each. ownerPhone is the owner's direct line (Business Contact Information); customerPhone is the number customers should call. When one box holds two numbers, the words around them decide; failing that, the first is the customer number. Give the same number for both when only one was given. Only numbers they typed.
- email: one email address, lower case. If its domain is clearly misspelled (gmial.com), keep it as typed and add a doubt.
- website: their current website as https://… Not a Facebook, Instagram, Yelp or Google Maps link. "" if they have none.
- street, city, state, zip: the business address. Keep the house number and street as typed (capitalisation aside). Use only a city, state or ZIP the client typed somewhere on the form (the address box, the business-contact box, the license information…), never one you worked out. A PO box isn't an address: leave street "" and add a doubt.
- townGuesses: only when the street came with no town: up to 3 "City, ST" places where it most likely is, best first, judged from the places they serve, their phones' area codes, their website and anything else on the form. The Hub checks each guess against the official US address map, so a wrong guess costs nothing; a missing one leaves the address unfinished.
- serviceCities: the places they serve, each "City ST" with the two-letter state ("Austin TX"); a county stays a county ("Cuyahoga County OH"). [] if they named none.
- timeZone: from their answer, else from their state; "" if neither says.
- ein: 9 digits as 12-3456789; "" if none or not 9 digits. A Social Security number (123-45-6789) is not an EIN.
- areaCode: the 3-digit area code they want; "" if none.
- notes: each change worth telling the team about, one short plain-English sentence each ("The business name and address boxes were swapped."). Leave out formatting-only changes.
- doubts: what a person should check or ask the client, one short sentence each. [] when everything is clear.`

const clean = (s: unknown): string => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '')
/** "N/A", "none", "-": a skipped answer. */
const skipped = (s: string) => !s || /^(n\/?a|n\.a\.|none|null|nil|-+|\.+)$/i.test(s)

/** The message Claude reads: every answer under its question. */
export function tidyMessage(a: TidyAnswers): string {
  const lines = [...TIDY_FIELDS, ...CONTEXT_FIELDS].map((f) => {
    const v = clean(a[f]).slice(0, (CONTEXT_FIELDS as readonly string[]).includes(f) ? 600 : 300)
    return `${QUESTIONS[f]}: ${v || '(blank)'}`
  })
  return `The client's answers, as submitted:\n\n${lines.join('\n')}`
}

/** Claude's answer, every field present and of the right kind; null when it isn't one. */
export function readAiTidy(v: unknown): AiTidy | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const s = (k: string) => clean(o[k])
  const l = (k: string) => (Array.isArray(o[k]) ? (o[k] as unknown[]).map(clean).filter(Boolean).slice(0, 8) : [])
  return {
    businessName: s('businessName'),
    ownerName: s('ownerName'),
    ownerPhone: s('ownerPhone'),
    customerPhone: s('customerPhone'),
    email: s('email'),
    website: s('website'),
    street: s('street'),
    city: s('city'),
    state: s('state'),
    zip: s('zip'),
    townGuesses: l('townGuesses'),
    serviceCities: l('serviceCities'),
    timeZone: s('timeZone'),
    ein: s('ein'),
    areaCode: s('areaCode'),
    notes: l('notes'),
    doubts: l('doubts'),
  }
}

export const digitsOf = (s: string | null | undefined): string => (s ?? '').replace(/\D/g, '')

/** Every 10-digit US phone number in the text (a leading 1 dropped). */
export function phonesIn(s: string | null | undefined): string[] {
  const out: string[] = []
  for (const m of (s ?? '').matchAll(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g)) {
    const d = digitsOf(m[0]).replace(/^1(?=\d{10}$)/, '')
    if (d.length === 10 && !out.includes(d)) out.push(d)
  }
  return out
}

/** "(216) 333-5885", or "" unless it's one 10-digit US number. */
export function formatPhone(s: string | null | undefined): string {
  const d = digitsOf(s).replace(/^1(?=\d{10}$)/, '')
  return d.length === 10 && /^[2-9]/.test(d) ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : ''
}

/** "12-3456789", or "" unless 9 digits that aren't written as a Social Security number. */
export function formatEin(s: string | null | undefined): string {
  const t = clean(s)
  if (/^\d{3}-\d{2}-\d{4}$/.test(t)) return ''
  const d = digitsOf(t)
  return d.length === 9 ? `${d.slice(0, 2)}-${d.slice(2)}` : ''
}

export function cleanEmail(s: string | null | undefined): string {
  const t = clean(s).toLowerCase()
  return /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/.test(t) ? t : ''
}

const SOCIAL = /(^|\.)(facebook|fb|instagram|yelp|tiktok|twitter|x|linkedin|nextdoor|thumbtack|angi|homeadvisor|youtube)\.com$|(^|\.)google\.[a-z.]+$|^maps\.app\.goo\.gl$|^g\.page$/i

/** "https://abc.com" (path kept), or "" when it isn't their own web address. */
export function cleanWebsite(s: string | null | undefined): string {
  const t = clean(s).replace(/[.,;]+$/, '')
  if (!t || /\s/.test(t) || t.includes('@')) return ''
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`)
    const host = u.hostname.toLowerCase()
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) || SOCIAL.test(host.replace(/^www\./, ''))) return ''
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')
    return `https://${host}${path}`
  } catch {
    return ''
  }
}

const BUSINESS_WORD = /\b(llc|inc|corp|co|company|construction|contracting|roofing|services?|solutions|enterprises?|group|pros?|masonry|concrete|plumbing|painting|cleaning|landscaping|remodel+ing|builders?|restoration|homes?)\b/i

/** One person's name: two to four words of letters, no business words. */
export function isPersonName(s: string | null | undefined): boolean {
  const t = clean(s)
  const words = t.split(' ')
  return words.length >= 2 && words.length <= 4 && words.every((w) => /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.-]*$/.test(w)) && !BUSINESS_WORD.test(t) && !/\b(and|&)\b/i.test(t)
}

/** A business name: not an address, phone, email or web address. */
export function isBusinessName(s: string | null | undefined): boolean {
  const t = clean(s)
  if (!t || t.length > 120 || skipped(t)) return false
  if (looksLikeAddress(t) || isPoBox(t)) return false
  if (/^[\d\s().+-]+$/.test(t) || t.includes('@') || /^(https?:\/\/|www\.)/i.test(t) || /^\S+\.(com|net|org|co|us|biz|info|io)$/i.test(t)) return false
  return /[A-Za-z]{2}/.test(t)
}

/** The house number a street starts with ("13982" in "13982 Sheldon rd"); "" when none. */
export function houseNumber(s: string | null | undefined): string {
  return /^\s*(\d+[A-Za-z]?)\b/.exec(s ?? '')?.[1]?.toLowerCase() ?? ''
}

/** The same house number on a street of the same name ("13982 SHELDON RD" and "13982 Sheldon rd"). */
export function sameHouse(a: string | null | undefined, b: string | null | undefined): boolean {
  const n = houseNumber(a)
  if (!n || n !== houseNumber(b)) return false
  const word = (s: string | null | undefined) =>
    clean(s)
      .toLowerCase()
      .replace(/^\d+[a-z]?\s+/, '')
      .replace(/^(n|s|e|w|north|south|east|west)\.?\s+/, '')
      .split(' ')[0] ?? ''
  return !!word(a) && word(a) === word(b)
}

/** A two-letter state code from "OH", "Ohio" or "ohio"; "" when it isn't a state. */
export function stateCode(s: string | null | undefined): string {
  const t = clean(s)
  if (!t) return ''
  const up = t.toUpperCase()
  if (STATE_CODE_TO_NAME[up]) return up
  const hit = Object.entries(STATE_NAME_TO_CODE).find(([name]) => name.toLowerCase() === t.toLowerCase())
  return hit?.[1] ?? ''
}

/** "BROOK PARK" → "Brook Park". */
export function titleCase(s: string): string {
  return clean(s)
    .toLowerCase()
    .replace(/(^|[\s-])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase())
}

/** "13982 Sheldon Rd, Brook Park, OH 44142": what the Hub's address reader takes back apart. */
export function oneLineAddress(a: { street: string; city: string; state: string; zip: string }): string {
  return [clean(a.street), clean(a.city), [clean(a.state), clean(a.zip)].filter(Boolean).join(' ')].filter(Boolean).join(', ')
}

/** "13982 SHELDON RD, BROOK PARK, OH, 44142" (the Census map's answer) in parts. */
export function parseCensusMatch(matched: string | null | undefined): { street: string; city: string; state: string; zip: string } | null {
  const parts = clean(matched)
    .split(',')
    .map((p) => p.trim())
  if (parts.length < 4) return null
  const [street, city, state, zip] = parts.slice(-4)
  if (!houseNumber(street) || !STATE_CODE_TO_NAME[state] || !/^\d{5}$/.test(zip)) return null
  return { street, city: titleCase(city), state, zip }
}

/** State names, longest first ("west virginia" before "virginia"). */
const STATE_NAMES = Object.keys(STATE_NAME_TO_CODE).sort((a, b) => b.length - a.length)

/** "Brook Park, OH", "Austin TX" or "Cuyahoga County, Ohio" → { city, state }; null without a real state. */
export function parseTown(s: string | null | undefined): { city: string; state: string } | null {
  const t = clean(s).replace(/,?\s*(usa|u\.s\.a\.|united states)$/i, '')
  const city = (rest: string) => clean(rest).replace(/,$/, '').trim()
  const code = /^(.+?)[\s,]+([A-Za-z]{2})\.?$/.exec(t)
  if (code && STATE_CODE_TO_NAME[code[2].toUpperCase()] && city(code[1])) return { city: city(code[1]), state: code[2].toUpperCase() }
  const lower = t.toLowerCase()
  const name = STATE_NAMES.find((n) => lower.endsWith(` ${n}`) || lower.endsWith(`,${n}`))
  if (name && city(t.slice(0, t.length - name.length))) return { city: city(t.slice(0, t.length - name.length)), state: STATE_NAME_TO_CODE[name] }
  return null
}

/** A word that shows up in the answers (a town, ZIP or state the client typed). */
function typedIn(all: string, word: string): boolean {
  const w = clean(word).toLowerCase()
  return !!w && new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(all)
}

/** Every answer in one lower-case text, for "did they type it?" checks. */
export function allAnswers(a: TidyAnswers): string {
  return [...TIDY_FIELDS, ...CONTEXT_FIELDS]
    .map((f) => clean(a[f]))
    .join(' \n ')
    .toLowerCase()
}

/**
 * The street the client typed: from the address box, else the name box when the two were swapped, else a
 * street written inside the business-contact or license answer. "" when there's none (or only a PO box).
 */
export function typedStreet(a: TidyAnswers): string {
  const box = clean(a.businessAddress)
  const inBox = parseUsAddress(box).street
  if (houseNumber(inBox) && !isPoBox(box)) return inBox
  const name = clean(a.businessName)
  if (looksLikeAddress(name) && !isPoBox(name)) {
    const inName = parseUsAddress(name).street
    if (houseNumber(inName)) return inName
  }
  for (const v of [a.businessContact, a.licenseInfo]) {
    const s = streetIn(v)
    const p = s ? parseUsAddress(s).street : ''
    if (houseNumber(p) && !isPoBox(s)) return p
  }
  return ''
}

/**
 * Where to look a street up, best first: the town the client typed, Claude's guesses, then the place they
 * serve and the business's own facts. States come with them, for a lookup across the whole state when the
 * map knows that street number in only one place there. `typed`: the town the client typed with the
 * street, which is looked at before anything else.
 */
export function placesToTry(a: TidyAnswers, ai: AiTidy | null, extra: { city?: string | null; state?: string | null }[] = []): { towns: string[]; states: string[]; typed: string | null } {
  const towns: string[] = []
  const states: string[] = []
  const add = (city: string | null | undefined, state: string | null | undefined) => {
    const st = stateCode(state)
    if (st && !states.includes(st)) states.push(st)
    const c = clean(city)
    if (c && st) {
      const t = `${c}, ${st}`
      if (!towns.some((x) => x.toLowerCase() === t.toLowerCase())) towns.push(t)
    }
  }
  const typed = parseUsAddress(clean(a.businessAddress))
  if (typed.city || typed.state) add(typed.city, typed.state)
  if (ai) {
    add(ai.city, ai.state)
    for (const g of ai.townGuesses) {
      const t = parseTown(g)
      if (t) add(t.city, t.state)
    }
    // The places they serve: a town is a guess too; a county only says the state.
    for (const c of ai.serviceCities.slice(0, 2)) {
      const t = parseTown(c)
      if (t) add(/\bcounty$/i.test(t.city) ? null : t.city, t.state)
    }
  }
  for (const e of extra) add(e.city, e.state)
  const typedTown = typed.city && stateCode(typed.state) ? `${typed.city}, ${stateCode(typed.state)}` : null
  return { towns: towns.slice(0, 5), states: states.slice(0, 3), typed: typedTown }
}

/** A street found on the address map: its town, state and ZIP, and how. */
export type FoundAddress = { street: string; city: string; state: string; zip: string; how: string }

export type TidyChange = { field: TidyField; from: string; to: string }
export type TidyResult = { updates: Partial<Record<TidyField, string>>; changes: TidyChange[]; notes: string[]; doubts: string[]; addressWhole: boolean }

/**
 * "13982 sheldon rd" → "13982 Sheldon Rd", "17434 Copeland ln" → "17434 Copeland Ln", "25 MAIN ST" →
 * "25 Main St": words typed all in small letters get a capital, directions are capitals (NW), and a word
 * already written with capitals (McDonald) stays as it is. The number is untouched.
 */
export function tidyStreet(street: string): string {
  const s = clean(street)
  const words = (s === s.toUpperCase() ? s.toLowerCase() : s).split(' ')
  return words
    .map((w) => {
      if (/^(n|s|e|w|ne|nw|se|sw)\.?$/i.test(w)) return w.toUpperCase()
      return /^[a-z][a-z'’.-]*$/.test(w) ? w[0].toUpperCase() + w.slice(1) : w
    })
    .join(' ')
}

/**
 * The answers as they should be stored: each of Claude's readings kept only when it passes its check, and
 * the address made whole only from what the client typed or what the address map found. What's left
 * unchanged is what Claude couldn't improve on.
 */
export function applyTidy(original: TidyAnswers, ai: AiTidy | null, found: FoundAddress | null): TidyResult {
  const o = (f: TidyField) => clean(original[f])
  const all = allAnswers(original)
  const next: Record<TidyField, string> = Object.fromEntries(TIDY_FIELDS.map((f) => [f, o(f)])) as Record<TidyField, string>
  const notes = (ai?.notes ?? []).slice(0, 6)
  const doubts = (ai?.doubts ?? []).slice(0, 6)

  if (ai) {
    if (isBusinessName(ai.businessName)) next.businessName = ai.businessName
    if (isPersonName(ai.ownerName)) next.fullName = ai.ownerName
    // A phone Claude gives has to be one the client typed: no numbers out of thin air.
    const typedPhones = phonesIn(all)
    const owner = formatPhone(ai.ownerPhone)
    const customer = formatPhone(ai.customerPhone)
    if (owner && typedPhones.includes(digitsOf(owner))) next.businessContact = owner
    if (customer && typedPhones.includes(digitsOf(customer))) next.customerPhone = customer
    const email = cleanEmail(ai.email)
    if (email && all.includes(email)) next.leadEmail = email
    const site = cleanWebsite(ai.website)
    if (site && all.includes(new URL(site).hostname.replace(/^www\./, ''))) next.website = site
    const ein = formatEin(ai.ein)
    if (ein && digitsOf(ein) === digitsOf(o('ein'))) next.ein = ein
    if (/^\d{3}$/.test(ai.areaCode) && all.includes(ai.areaCode)) next.areaCode = ai.areaCode
    if ((TIME_ZONES as readonly string[]).includes(ai.timeZone)) next.timeZone = ai.timeZone
    const cities = ai.serviceCities.filter((c) => {
      const t = parseTown(c)
      return !!t && typedIn(all, t.city.replace(/\s+county$/i, ''))
    })
    if (cities.length) next.cities = cities.join(', ')
  }
  // Formatting alone, when Claude wasn't reached (or gave nothing better).
  if (next.customerPhone === o('customerPhone') && phonesIn(o('customerPhone')).length === 1) next.customerPhone = formatPhone(o('customerPhone'))
  if (next.businessContact === o('businessContact') && phonesIn(o('businessContact')).length === 1 && digitsOf(o('businessContact')).length <= 11) next.businessContact = formatPhone(o('businessContact'))
  if (next.ein === o('ein') && formatEin(o('ein'))) next.ein = formatEin(o('ein'))
  if (next.website === o('website') && cleanWebsite(o('website'))) next.website = cleanWebsite(o('website'))
  if (next.leadEmail === o('leadEmail') && cleanEmail(o('leadEmail'))) next.leadEmail = cleanEmail(o('leadEmail'))

  // The address: the street they typed, its town, state and ZIP from what they typed or what the map found.
  const street = typedStreet(original)
  const aiStreet = ai && sameHouse(ai.street, street) ? ai.street : ''
  const typedTown = ai && ai.city && typedIn(all, ai.city) && stateCode(ai.state) && (typedIn(all, ai.state) || typedIn(all, STATE_CODE_TO_NAME[stateCode(ai.state)] ?? '')) ? { city: ai.city, state: stateCode(ai.state) } : null
  const typedZip = ai && /^\d{5}$/.test(ai.zip) && all.includes(ai.zip) ? ai.zip : ''
  let addressWhole = false
  if (street && found && sameHouse(found.street, street)) {
    next.businessAddress = oneLineAddress({ street: tidyStreet(aiStreet || street), city: found.city, state: found.state, zip: found.zip })
    addressWhole = true
    notes.push(`Completed the business address to ${next.businessAddress} (${found.how}).`)
  } else if (street && typedTown && typedZip) {
    next.businessAddress = oneLineAddress({ street: tidyStreet(aiStreet || street), city: typedTown.city, state: typedTown.state, zip: typedZip })
    addressWhole = true
  } else {
    const p = parseUsAddress(next.businessAddress)
    addressWhole = !!(p.street && p.city && p.state && p.zip)
    // The address landed in the name box: at least put it back where it belongs.
    if (!addressWhole && street && !parseUsAddress(o('businessAddress')).street && next.businessName !== o('businessName')) next.businessAddress = tidyStreet(aiStreet || street)
    if (!addressWhole) doubts.push(street ? 'Their business address has no city, state or ZIP the address map could confirm: ask the client for the full address.' : 'They gave no street address for the business: ask the client for it (a PO box won’t do for a texting registration).')
  }

  const updates: Partial<Record<TidyField, string>> = {}
  const changes: TidyChange[] = []
  for (const f of TIDY_FIELDS) {
    if (next[f] && next[f] !== o(f)) {
      updates[f] = next[f]
      changes.push({ field: f, from: o(f), to: next[f] })
    }
  }
  return { updates, changes, notes: [...new Set(notes)], doubts: [...new Set(doubts)], addressWhole }
}

/** One Slack line for the team: what changed that matters, and what a person should check. Null when there's nothing to say. */
export function tidySummary(name: string, r: Pick<TidyResult, 'notes' | 'doubts'>): string | null {
  if (!r.notes.length && !r.doubts.length) return null
  const said = r.notes.length ? ` ${r.notes.join(' ')}` : ''
  const check = r.doubts.length ? ` *Check:* ${r.doubts.join(' ')}` : ''
  return `:broom: *Onboarding answers tidied* — *${name}*.${said}${check}`
}
