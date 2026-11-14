/**
 * Forge's website build for a new client (pure; the database, Claude and
 * Lovable are in ./site-request.ts and ./site-fill.ts).
 *
 * Right after onboarding makes a Hell-level sub-account, Forge asks in the
 * Office: build their website? On a Yes, Claude fills Ethan's one-shot
 * (./site-template.ts) from the onboarding answers, the Hub copies the
 * template project in Lovable and sends the copy the one-shot, and Forge
 * reports until Lovable is done. Then Forge asks again: publish it? Nothing
 * is published without that second Yes; nothing is connected or bought.
 *
 * This file decides who gets asked, which uploads count as photos, which
 * phone and domain go on the site, turns Claude's answers into the
 * template's variables, and says where a built site's form links its
 * privacy and terms pages.
 */
import { isRealDomain, renderOneShot, type OneShotVars } from './site-template'

/** Robert Taylor's site (Jake's Property Maintenance): the project Ethan remixes for every new client. */
export const DEFAULT_TEMPLATE_PROJECT = '793befd4-d2b4-4a7a-ba08-029e195a3007'

export type SiteStatus =
  | 'awaiting_approval'
  | 'declined'
  | 'filling'
  | 'copying'
  | 'sending'
  | 'building'
  | 'waiting_on_lovable'
  | 'built'
  | 'held'
  | 'publishing'
  | 'published'
  | 'connecting'
  | 'connected'
  | 'failed'

/** The Hub is working on it (a step runs, Lovable builds, it's being published or its domain connected): nobody can ask again meanwhile. */
export const SITE_WORKING: SiteStatus[] = ['filling', 'copying', 'sending', 'building', 'waiting_on_lovable', 'publishing', 'connecting']

/** Built and not published: the statuses a person can press Publish it from. */
export const SITE_PUBLISHABLE: SiteStatus[] = ['built', 'held']

// ---------------------------------------------------------------------------
// Who gets asked
// ---------------------------------------------------------------------------

export type SiteAskCandidate = {
  archived: boolean
  accountId: string | null
  /** Clients: the site we built is live. */
  siteLive: boolean
  /** A GHL sub-account is linked: set up in GHL, so their site is built by hand with GHL's form. */
  ghlLinked: boolean
  request: { status: string } | null
  trigger: 'onboarding' | 'sweep' | 'manual'
  /** By hand only: ask even though a GHL sub-account is linked. */
  overrideGhl?: boolean
  accountCreatedAt: Date | null
  since: Date
}

/**
 * Forge asks once per new Hell-level client, right after onboarding made
 * their sub-account. By hand a person can ask for any client with a
 * sub-account, again after a Not now, a failure or a finished build (a new
 * copy each time); a client set up in GHL only with overrideGhl.
 */
export function siteAskDecision(c: SiteAskCandidate): { ask: boolean; reason: string } {
  if (c.archived) return { ask: false, reason: 'the client is archived' }
  if (!c.accountId) return { ask: false, reason: 'no Hell-level sub-account yet' }
  const r = c.request?.status
  if (r === 'awaiting_approval') return { ask: false, reason: 'already asked' }
  if (r && (SITE_WORKING as string[]).includes(r)) return { ask: false, reason: 'its site is being built' }
  if (c.ghlLinked && !(c.trigger === 'manual' && c.overrideGhl)) return { ask: false, reason: 'they have a GHL sub-account (set up in GHL)' }
  if (c.trigger !== 'manual') {
    if (c.siteLive) return { ask: false, reason: 'their site is already live' }
    if (r === 'built' || r === 'held' || r === 'published' || r === 'connected') return { ask: false, reason: 'their site was already built' }
    if (r === 'declined') return { ask: false, reason: 'someone answered Not now' }
    if (r) return { ask: false, reason: 'the last try failed; a person picks it up' }
    if (c.trigger === 'sweep' && (!c.accountCreatedAt || c.accountCreatedAt.getTime() < c.since.getTime())) {
      return { ask: false, reason: 'its sub-account is older than the website question' }
    }
  }
  return { ask: true, reason: 'no site yet' }
}

// ---------------------------------------------------------------------------
// Uploads, phone, domain, social links
// ---------------------------------------------------------------------------

export type SitePhoto = { url: string; name: string }
export type SkippedFile = { name: string; why: string }

/** "…/intake-uploads/1794-ab/IMG_0265.jpeg?token=…" → "IMG_0265.jpeg". */
export function fileName(url: string): string {
  try {
    const path = new URL(url).pathname
    return decodeURIComponent(path.split('/').filter(Boolean).pop() ?? url)
  } catch {
    return url.split('?')[0].split('/').pop() ?? url
  }
}

const PHOTO = /\.(jpe?g|png|webp|gif)$/i
/** EIN / IRS letters by name (Ethan's rule: filenames containing "cp575" or "EIN"). */
const TAX_DOC = /cp[\s_-]?575|(^|[^a-z])ein([^a-z]|$)|\birs\b|w-?9\b/i

/**
 * The uploads that can be photos on the site, in the order they came, and
 * why the rest can't: documents (PDF, Word), EIN or IRS letters by name, and
 * iPhone HEIC files (browsers can't show them). Whether a photo is really a
 * screenshot or a picture of a document is Claude's call (it looks at them).
 */
export function pickPhotos(files: string[], max = 30): { photos: SitePhoto[]; skipped: SkippedFile[] } {
  const photos: SitePhoto[] = []
  const skipped: SkippedFile[] = []
  const seen = new Set<string>()
  for (const raw of files) {
    const url = raw.trim()
    if (!/^https:\/\//i.test(url) || seen.has(url)) continue
    seen.add(url)
    const name = fileName(url)
    if (TAX_DOC.test(name)) skipped.push({ name, why: 'an EIN or IRS document' })
    else if (/\.(heic|heif)$/i.test(name)) skipped.push({ name, why: 'an iPhone HEIC photo, which browsers can’t show' })
    else if (!PHOTO.test(name)) skipped.push({ name, why: /\.(pdf|docx?|txt|rtf)$/i.test(name) ? 'a document' : 'not a photo' })
    else if (photos.length >= max) skipped.push({ name, why: `more than ${max} photos` })
    else photos.push({ url, name })
  }
  return { photos, skipped }
}

/**
 * "+14843627127" → { display: "(484) 362-7127", e164: "+14843627127" }; null
 * when there's no US number. An answer with two ("540-… and 703-…") gives
 * the first.
 */
export function phoneParts(raw: string | null | undefined): { display: string; e164: string } | null {
  for (const part of (raw ?? '').split(/\s*(?:,|;|\/|&|\n|\band\b|\bor\b)\s*/i)) {
    const d = part.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
    if (d.length === 10) return { display: `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`, e164: `+1${d}` }
  }
  return null
}

/** The first email address in an answer ("a@x.com and b@y.com" → "a@x.com"), or blank. */
export function firstEmail(raw: string | null | undefined): string {
  return /[^\s@,;:<>()"']+@[^\s@,;:<>()"']+\.[a-z]{2,}/i.exec(raw ?? '')?.[0] ?? ''
}

/** "https://www.Acme.com/x" → "acme.com"; null when it isn't a domain. */
export function cleanDomain(raw: string | null | undefined): string | null {
  const s = (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '')
  return isRealDomain(s) ? s : null
}

const SOCIAL: [RegExp, string][] = [
  [/facebook\.com|fb\.com|fb\.me/i, 'Facebook'],
  [/instagram\.com/i, 'Instagram'],
  [/tiktok\.com/i, 'TikTok'],
  [/youtube\.com|youtu\.be/i, 'YouTube'],
  [/linkedin\.com/i, 'LinkedIn'],
  [/(^|\.)x\.com|twitter\.com/i, 'X'],
  [/yelp\.com/i, 'Yelp'],
  [/nextdoor\.com/i, 'Nextdoor'],
  [/pinterest\.com/i, 'Pinterest'],
  [/angi\.com|angieslist\.com/i, 'Angi'],
  [/thumbtack\.com/i, 'Thumbtack'],
  [/houzz\.com/i, 'Houzz'],
  [/bbb\.org/i, 'BBB'],
]

/** Real profile links in an answer (anything else, like "none" or a handle, isn't a link). */
export function socialLinksFrom(text: string | null | undefined): { label: string; url: string }[] {
  const out: { label: string; url: string }[] = []
  for (const m of (text ?? '').matchAll(/(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|me|be|net)\/[^\s,;)"'<>]+/gi)) {
    const raw = m[0].replace(/[.,]+$/, '')
    const label = SOCIAL.find(([re]) => re.test(raw))?.[1]
    if (!label) continue
    const url = /^https?:\/\//i.test(raw) ? raw.replace(/^http:/i, 'https:') : `https://${raw}`
    if (!out.some((x) => x.url.toLowerCase() === url.toLowerCase())) out.push({ label, url })
  }
  return out
}

/** A Google Business Profile link from the answer, if it is one. */
export function gbpLinkFrom(text: string | null | undefined): string | null {
  const m = /(?:https?:\/\/)?(?:www\.)?(?:google\.[a-z.]+\/maps\/[^\s,;)"'<>]+|maps\.app\.goo\.gl\/[^\s,;)"'<>]+|g\.page\/[^\s,;)"'<>]+|goo\.gl\/maps\/[^\s,;)"'<>]+|share\.google\/[^\s,;)"'<>]+|g\.co\/kgs\/[^\s,;)"'<>]+|business\.google\.com\/[^\s,;)"'<>]+)/i.exec(text ?? '')
  if (!m) return null
  const raw = m[0].replace(/[.,]+$/, '')
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
}

/** IANA zone → the word the one-shot uses. */
export function zoneWord(zone: string | null | undefined): string | null {
  switch (zone) {
    case 'America/New_York':
      return 'Eastern'
    case 'America/Chicago':
      return 'Central'
    case 'America/Denver':
      return 'Mountain'
    case 'America/Phoenix':
      return 'Mountain (Arizona, no daylight saving)'
    case 'America/Los_Angeles':
      return 'Pacific'
    case 'America/Anchorage':
      return 'Alaska'
    case 'Pacific/Honolulu':
      return 'Hawaii'
    default:
      return null
  }
}

/** The copy's name in Lovable, like Ethan's: the owner's full name, else the business name. */
export function projectNameFor(owner: string | null | undefined, business: string): string {
  const name = (owner ?? '').replace(/\s+/g, ' ').trim() || business.replace(/\s+/g, ' ').trim()
  return name.slice(0, 80) || 'New client site'
}

// ---------------------------------------------------------------------------
// The facts, Claude's answers, and the filled one-shot
// ---------------------------------------------------------------------------

/** Everything the Hub knows that the one-shot uses, as supplied (Claude only reads it). */
export type SiteFacts = {
  clientName: string
  /** As typed on the form (possibly lower case, "llc."). */
  legalName: string
  businessName: string
  ownerName: string
  phone: { display: string; e164: string } | null
  /** Where the phone came from, for the Office: their toll-free number, or their own. */
  phoneSource: 'toll_free' | 'hell_level' | 'ghl' | 'own' | null
  email: string
  address: string
  cities: string
  timeZoneAnswer: string
  /** The zone the Hub works out from the answer or the address. */
  timeZoneHint: string | null
  /** "Website link" on the form: the site they have now, if any. */
  currentWebsite: string
  /** The domain the site goes on, when there is one: theirs, or one bought for them. */
  domain: string | null
  about: string
  mainServices: string
  whyChooseYou: string
  promotions: string
  brandColors: string
  faqs: string
  yearStarted: string
  licenseInfo: string
  socialLinks: { label: string; url: string }[]
  gbpLink: string | null
  photos: SitePhoto[]
  skipped: SkippedFile[]
}

/** What Claude writes from the facts (src/lib/hl/site-fill.ts holds the matching schema). */
export type SiteFill = {
  legalName: string
  displayName: string
  cityState: string
  /** Blank when the address is incomplete, a PO box or an apartment (the one-shot then uses the city and state). */
  fullAddress: string
  serviceAreaSummary: string
  serviceAreaList: string[]
  timeZone: string
  yearStarted: string
  experienceLine: string
  licenseLine: string
  about: string
  whyChooseUs: string[]
  promo: string
  extraFacts: string[]
  brandColors: string
  colorDirection: string
  trade: string
  regionContext: string
  heroHeadline: string
  heroCopy: string
  heroImage: string
  primaryCta: string
  services: { name: string; note: string }[]
  /** One per photo shown to Claude, by its number (1-based). */
  photos: { photo: number; keep: boolean; shows: string; useFor: string }[]
  aiImageScenes: string
  mapInstructions: string
  faqs: { question: string; answer: string }[]
  blogTopics: string[]
  tradeClaimRules: string[]
  /** Anything a person should know before this goes to Lovable. */
  notes: string[]
}

export type SiteEmbeds = { formId: string; formEmbed: string; chatId: string; chatEmbed: string }

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const one = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()
const bullets = (items: string[]) =>
  items
    .map(one)
    .filter(Boolean)
    .map((x) => `- ${x.replace(/^[-•*]\s*/, '')}`)
    .join('\n')

/**
 * The photos to list for Lovable. `shown` is which of `photos` Claude looked
 * at, in the order it saw them ("Photo 1" is photos[shown[0]]): of those,
 * the ones it kept, with what each shows. A photo it couldn't look at (too
 * big) goes in as it is; one it looked at and didn't answer for stays out.
 */
export function keptPhotos(photos: SitePhoto[], fill: Pick<SiteFill, 'photos'> | null, shown: number[]): { url: string; shows: string; useFor: string }[] {
  const out: { url: string; shows: string; useFor: string }[] = []
  const used = new Set<number>()
  for (const p of fill?.photos ?? []) {
    const i = shown[Math.round(p.photo) - 1]
    if (!p.keep || i === undefined || i < 0 || i >= photos.length || used.has(i)) continue
    used.add(i)
    out.push({ url: photos[i].url, shows: one(p.shows), useFor: one(p.useFor) })
  }
  const seen = new Set(shown)
  photos.forEach((p, i) => {
    if (!seen.has(i)) out.push({ url: p.url, shows: '', useFor: '' })
  })
  return out
}

/** The template's variables from the facts, Claude's answers and the Hell-level embeds. Throws when something the site can't go without is missing. */
export function oneShotVars(facts: SiteFacts, fill: SiteFill, embeds: SiteEmbeds, opts: { shown: number[] }): OneShotVars {
  if (!facts.phone) throw new Error('No phone number on file for the site.')
  if (!facts.email) throw new Error('No email address on file for the site.')
  // Claude may fix the capitals and dots of the legal name, never its words.
  const legal = one(fill.legalName) && words(fill.legalName) === words(facts.legalName) ? one(fill.legalName) : one(facts.legalName)
  const cityState = one(fill.cityState)
  const photos = keptPhotos(facts.photos, fill, opts.shown)
  const domain = facts.domain ?? ''
  return {
    LEGAL_NAME: legal,
    DISPLAY_NAME: one(fill.displayName) || legal,
    OWNER_NAME: one(facts.ownerName),
    PHONE_DISPLAY: facts.phone.display,
    PHONE_E164: facts.phone.e164,
    EMAIL: facts.email.trim(),
    FULL_ADDRESS: one(fill.fullAddress) || cityState,
    CITY_STATE: cityState,
    SERVICE_AREA_SUMMARY: one(fill.serviceAreaSummary),
    SERVICE_AREA_LIST: bullets(fill.serviceAreaList),
    TIME_ZONE: one(fill.timeZone) || facts.timeZoneHint || '',
    DOMAIN: domain || 'this website',
    DOMAIN_AT: domain ? `at ${domain}` : 'on this website',
    YEAR_STARTED: /^(18|19|20)\d\d$/.test(one(fill.yearStarted)) ? one(fill.yearStarted) : '',
    EXPERIENCE_LINE: one(fill.experienceLine),
    LICENSE_LINE: one(fill.licenseLine),
    SOCIAL_LINKS: facts.socialLinks.map((s) => `${s.label}: ${s.url}`).join(', '),
    GBP_LINK: facts.gbpLink ?? '',
    EXTRA_FACTS: fill.extraFacts.map(one).filter(Boolean).join('; '),
    ABOUT: one(fill.about),
    WHY_CHOOSE_US: bullets(fill.whyChooseUs),
    PROMO: one(fill.promo),
    TRADE_CLAIM_RULES: bullets(fill.tradeClaimRules),
    BRAND_COLORS: one(fill.brandColors) || 'none supplied',
    COLOR_DIRECTION: one(fill.colorDirection),
    TRADE: one(fill.trade),
    REGION_CONTEXT: one(fill.regionContext),
    HERO_HEADLINE: one(fill.heroHeadline),
    HERO_COPY: one(fill.heroCopy).replace(/^"|"$/g, ''),
    // The photo list Lovable gets isn't numbered, so "(photo 13)" would mean nothing to it.
    HERO_IMAGE: one(fill.heroImage).replace(/\s*\((?:client |their )?photos? \d+(?:\s*(?:,|and|&)\s*\d+)*\)/gi, ''),
    PRIMARY_CTA: one(fill.primaryCta).replace(/^"|"$/g, ''),
    SERVICES_LIST: fill.services
      .filter((s) => one(s.name))
      .map((s, i) => `${i + 1}. **${one(s.name)}**${one(s.note) ? ` (${one(s.note)})` : ''}`)
      .join('\n'),
    AI_IMAGE_SCENES: one(fill.aiImageScenes),
    CLIENT_PHOTO_URLS: photos.map((p) => `- ${p.url}${p.shows ? ` — ${p.shows}` : ''}${p.useFor ? ` (use for: ${p.useFor})` : ''}`).join('\n'),
    MAP_INSTRUCTIONS: one(fill.mapInstructions),
    FAQ_BLOCK: fill.faqs
      .filter((f) => one(f.question) && one(f.answer))
      .map((f) => `**${one(f.question)}**\n${one(f.answer)}`)
      .join('\n\n'),
    BLOG_TOPICS: fill.blogTopics
      .map(one)
      .filter(Boolean)
      .slice(0, 9)
      .map((t, i) => `${i + 1}. ${t}`)
      .join('\n'),
    FORM_EMBED: embeds.formEmbed,
    FORM_ID: embeds.formId,
    CHAT_WIDGET_CODE: embeds.chatEmbed,
    WIDGET_ID: embeds.chatId,
  }
}

/** The filled one-shot, ready for Lovable. */
export function buildOneShot(facts: SiteFacts, fill: SiteFill, embeds: SiteEmbeds, opts: { shown: number[] }): string {
  return renderOneShot(oneShotVars(facts, fill, embeds, opts))
}

/** What the Office shows under "Build X's website?": what the site will get, and what's still missing. */
export function siteQuestionDetail(f: {
  photos: number
  skipped: number
  domain: string | null
  phoneSource: SiteFacts['phoneSource']
  numberAsked: boolean
  domainAsked: boolean
  missing: string[]
}): string {
  if (f.missing.length) return `Can’t build yet: no ${f.missing.join(' or ')} on file. Add it in their Hell-level → Settings → Business Profile.`
  const parts = [
    f.photos ? `${f.photos} photo${f.photos === 1 ? '' : 's'} from onboarding${f.skipped ? ` (${f.skipped} other upload${f.skipped === 1 ? '' : 's'} left out)` : ''}` : 'No photos: Lovable makes them all',
    f.domain ? `Domain ${f.domain}` : f.domainAsked ? 'No domain yet: answer Forge’s domain question first to put it in the site' : 'No domain yet: the site says “this website”',
    f.phoneSource === 'toll_free' || f.phoneSource === 'hell_level' || f.phoneSource === 'ghl'
      ? 'Their toll-free number goes on the site'
      : f.numberAsked
        ? 'Their own phone goes on the site: answer Echo’s toll-free question first to use that number'
        : 'Their own phone goes on the site',
  ]
  return `${parts.join('. ')}.`
}

/** Office wording for the status. */
export const SITE_STATUS_TEXT: Record<SiteStatus, string> = {
  awaiting_approval: 'Asked in the Office',
  declined: 'Not now',
  filling: 'Claude is filling the one-shot',
  copying: 'Copying the template in Lovable',
  sending: 'Sending the one-shot to Lovable',
  building: 'Lovable is building the site',
  waiting_on_lovable: 'Lovable is waiting for a person',
  built: 'Built in Lovable: review it, then publish it from the Office',
  held: 'Built in Lovable, not published (Not now)',
  publishing: 'Publishing in Lovable',
  published: 'Published',
  connecting: 'Connecting their domain',
  connected: 'Live on their domain',
  failed: 'Didn’t finish',
}

// ---------------------------------------------------------------------------
// Publishing, and the built site's own policy pages
// ---------------------------------------------------------------------------

const LEGAL_ENDING = /\b(l\.?l\.?c|inc|incorporated|corp|corporation|co|company|ltd|pllc|lp)\b\.?/gi

/**
 * The lovable.app name Forge asks for when it publishes: the business name,
 * "Acme Roofing & Gutters, LLC" → acme-roofing-and-gutters(.lovable.app).
 * Null when too little of the name is left; Lovable then picks one.
 */
export function publishSlug(business: string): string | null {
  const slug = business
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(LEGAL_ENDING, ' ')
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '')
  return slug.length >= 3 ? slug : null
}

/** The policy pages every site Forge builds has: the template's /privacy and /terms. */
export const BUILT_SITE_PAGES = { privacy: '/privacy', terms: '/terms' } as const

/** Lovable serves it: a copy's preview, or a site published at lovable.app. */
export const isLovableHost = (host: string) => /(^|\.)(lovable\.app|lovableproject\.com)$/i.test(host)

/** A host as compared here: lowercase, no www. Accepts a bare domain or a full link. */
export function bareHost(v: string | null | undefined): string | null {
  const s = v?.trim()
  if (!s) return null
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase().replace(/^www\./, '') || null
  } catch {
    return null
  }
}

/**
 * The privacy and terms links for a form or chat shown on `shownOn` (the
 * page's address as the browser sends it), when that page is the site Forge
 * built for the client: that site's own /privacy and /terms (Alex,
 * 2026-11-13: the consent links on the site open the site's pages, not the
 * Hub's). The page counts when Lovable serves it (the copy's preview, or
 * its lovable.app address) or it's at one of the client's own addresses
 * (`ownHosts`). Null otherwise, and on the Hub itself: the usual links apply.
 */
/** A form's policy links: null where there's no page of the client's own to link (the words then show without a link). */
export type OwnLegalLinks = { privacy: string | null; terms: string | null }

/**
 * For each link, the first option that's a web address and not one of the
 * Hub's own pages (Alex, 2026-11-13: forms and chat never link the Hub's
 * /hl/legal pages). Null when no option has one.
 */
export function firstOwnLinks(options: ({ privacy?: string | null; terms?: string | null } | null | undefined)[], isHub: (url: string) => boolean): OwnLegalLinks {
  const pick = (k: 'privacy' | 'terms') =>
    options.map((o) => o?.[k]?.trim() || null).find((u): u is string => !!u && /^https?:\/\/[^\s/$.?#][^\s]*$/i.test(u) && !isHub(u)) ?? null
  return { privacy: pick('privacy'), terms: pick('terms') }
}

export function builtSiteLegal(shownOn: string | null | undefined, ownHosts: string[], hubHosts: string[]): { privacy: string; terms: string } | null {
  let url: URL
  try {
    url = new URL(shownOn ?? '')
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = bareHost(url.href)
  if (!host || hubHosts.includes(host) || host.endsWith('.onrender.com')) return null
  if (!isLovableHost(host) && !ownHosts.includes(host)) return null
  return { privacy: `${url.origin}${BUILT_SITE_PAGES.privacy}`, terms: `${url.origin}${BUILT_SITE_PAGES.terms}` }
}

// ---------------------------------------------------------------------------
// Connecting the client's domain to the published site
// ---------------------------------------------------------------------------

/** A domain on the client's Hell-level sub-account, as the Domains page holds it. */
export type SiteDomainRow = { name: string; origin: string; status: string }

/**
 * The domain Forge connects. managed: held in the Hub's Porkbun account
 * (bought, moved in or linked), so the Hub sets its DNS. Not managed: added
 * in Hell-level → Domains as one whose DNS stays elsewhere, so a person adds
 * the records Forge lists. waiting: one still moving in. Null: none yet.
 */
export type SiteDomainChoice = { name: string; managed: boolean } | { waiting: string } | null

/** The client's domain for the site, oldest first (the one the one-shot named): one held here, else one whose DNS is elsewhere. */
export function siteDomainChoice(domains: SiteDomainRow[]): SiteDomainChoice {
  const held = domains.find((d) => d.origin !== 'external' && d.status === 'active')
  if (held) return { name: held.name, managed: true }
  const moving = domains.find((d) => d.origin !== 'external' && ['pending', 'held', 'transferring'].includes(d.status))
  if (moving) return { waiting: moving.name }
  const elsewhere = domains.find((d) => d.origin === 'external' && d.status === 'active')
  return elsewhere ? { name: elsewhere.name, managed: false } : null
}

/** The message that asks the copy's Lovable agent to connect the domain (Lovable has no API for domains, only its editor and its chat). */
export function domainConnectMessage(domain: string, managed: boolean): string {
  return [
    `Connect my custom domain ${domain} to this project, with www.${domain} going to it too.`,
    `I already own ${domain} and ${managed ? 'manage its DNS myself at Porkbun' : 'manage its DNS myself'}, so don't buy a domain, don't move its nameservers, and don't change any code or content.`,
    'Once it is connected, reply with the exact DNS records to add: type, host and value for each, including the full TXT verification values (they start with lovable_verify=).',
  ].join(' ')
}

/** lovable_verify=…: dots only inside the value, so a sentence's full stop isn't taken as part of it. */
const VERIFY = /lovable_verify=[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/g

/**
 * Lovable's verification values in its reply: the one on the _lovable.www
 * line for www, the one on the _lovable line for the domain. Without those
 * names, the first value is the domain's and a second one www's.
 */
export function lovableVerifyCodes(text: string): { rootTxt: string | null; wwwTxt: string | null } {
  let rootTxt: string | null = null
  let wwwTxt: string | null = null
  const loose: string[] = []
  for (const line of text.split('\n')) {
    for (const code of line.match(VERIFY) ?? []) {
      if (/_lovable\.www\b/i.test(line)) wwwTxt ??= code
      else if (/_lovable\b/i.test(line)) rootTxt ??= code
      else loose.push(code)
    }
  }
  for (const code of loose) {
    if (code === rootTxt || code === wwwTxt) continue
    if (!rootTxt) rootTxt = code
    else if (!wwwTxt) wwwTxt = code
  }
  return { rootTxt, wwwTxt }
}

/**
 * Whether the action Lovable paused on is connecting exactly this domain,
 * and nothing that buys, registers or moves anything. Only then does the
 * Hub approve it for the person who said Yes in the Office; anything else
 * waits for a person in Lovable.
 */
export function approvesDomainConnect(toolId: string | null, params: unknown, domain: string): boolean {
  const text = `${toolId ?? ''} ${JSON.stringify(params ?? {})}`.toLowerCase()
  if (/buy|purchase|regist|checkout|payment|billing|transfer|nameserver|delete|remove|disconnect/.test(text)) return false
  return /domain/.test(text) && text.includes(domain.toLowerCase())
}
