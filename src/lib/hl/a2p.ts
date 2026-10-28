import { prisma } from '@/lib/prisma'
import type { HlA2p, Prisma } from '@/generated/prisma/client'
import { parseUsAddress } from '@/lib/address-parse'
import { a2pPrefill, boardFacts, type A2pInputs } from '@/lib/a2p'
import { readProfile } from './accounts'
import { HlInputError } from './http'
import { asSettings, consentsOf } from './forms'
import { fillLegalLinksFromSite, hostedLegalUrl, isHubUrl, resolveLegalLinks, siteFormPages, type LegalLinks } from './legal-links'
import { prettyPhone } from './merge'
import { splitName, toE164 } from './phone'
import { individualProfileProblem, primaryProfile, readTwilioSettings } from './verification'
import { publicBase, twilioAccountType, twilioClient, type TwilioClient } from './twilio'
import {
  ACTIVE_STAGES,
  LIMITS,
  detailProblems,
  type A2pCheck,
  type A2pDetails,
  type A2pPath,
  type A2pScreenshot,
  type A2pStage,
  type A2pView,
  withOptInLink,
} from './a2p-shared'

/**
 * A2P 10DLC for local numbers, filed with Twilio as the ISV (Genisys) for
 * the sub-account's business. In order, as Twilio's ISV guide has it:
 *
 *   1. Trust Hub: a secondary customer profile (a "starter" one for a sole
 *      proprietor) with the business, its authorized representative and its
 *      address, tied to Genisys's own approved primary profile; then an A2P
 *      trust bundle. Free. Filed straight away when someone clicks File.
 *   2. The brand, with The Campaign Registry. Charged ($4.50 low volume or
 *      sole prop, $46 standard). Made by the scheduler a minute later, as
 *      Twilio wants a pause between steps.
 *   3. Once the registry approves the brand (for a sole proprietor, once the
 *      owner replies YES to its text): a Messaging Service holding the local
 *      numbers, and the campaign on it. Charged ($15 review, then the monthly
 *      fee once approved). Carriers review it in days to a few weeks.
 *
 * A private business with an EIN never has to give a code: the registry
 * only emails one to publicly traded companies. Nothing costs money until a
 * person clicks File on the review screen (with the price on the button),
 * and every paid step looks for an existing brand or campaign first and
 * runs under a claim on the row, so nothing is ever filed (or paid) twice.
 * Rejected brands and campaigns are fixed and resubmitted in place; Twilio
 * charges a campaign's review fee once, however often it's resubmitted.
 */

const POLICY = {
  secondaryProfile: 'RNdfbf3fae0e1107f8aded0e7cead80bf5',
  starterProfile: 'RN806dd6cd175f314e1f96a9727ee271f4',
  a2pTrust: 'RNb0d4771c2c98518d916a3d4cd70a8f8b',
  soleTrust: 'RN670d5d2e282a6130ae063b234b6019c8',
} as const

/** Pause before registering the brand after the Trust Hub filing. */
const BRAND_PAUSE_MS = 45_000
const LOCK_MS = 3 * 60_000

type Meta = {
  businessEndUser?: string
  repEndUser?: string
  starterEndUser?: string
  trustEndUser?: string
  addressSid?: string
  documentSid?: string
  /** PN sids on the Messaging Service. */
  attached?: string[]
  failedStep?: 'profile' | 'trust' | 'brand' | 'numbers' | 'campaign'
  usecase?: string
  /** Genisys's own business: the brand sits on the primary profile itself. */
  own?: boolean
  /** The last time a rejected campaign was fixed and resubmitted, and the status Twilio answered with. */
  resubmittedAt?: string
  resubmitStatus?: string
  resubmits?: number
  /** When a check found the registry's or carriers' rejection. */
  rejectedAt?: string
}

type Deps = { client?: TwilioClient; now?: Date }

const readMeta = (v: unknown): Meta => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Meta) : {})
const asJson = (v: unknown) => v as Prisma.InputJsonValue

/** A step Twilio refused, in words someone can act on. */
class StepError extends Error {
  constructor(
    message: string,
    readonly step: NonNullable<Meta['failedStep']>,
  ) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// The review screen's starting values
// ---------------------------------------------------------------------------

const clean = (s: unknown) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '')
const cleanBlock = (s: unknown) => (typeof s === 'string' ? s.replace(/\r\n/g, '\n').trim() : '')

/** The details as posted, trimmed and capped (detailProblems says what's still wrong). */
export function cleanDetails(raw: unknown): A2pDetails {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const path: A2pPath = r.path === 'standard' || r.path === 'sole_prop' ? r.path : 'low_volume'
  const ein = clean(r.ein).replace(/\D/g, '')
  return {
    path,
    legalName: clean(r.legalName).slice(0, 200),
    businessType: clean(r.businessType),
    ein: ein.length === 9 ? `${ein.slice(0, 2)}-${ein.slice(2)}` : clean(r.ein),
    industry: clean(r.industry),
    website: clean(r.website).slice(0, 300),
    street: clean(r.street).slice(0, 200),
    city: clean(r.city).slice(0, 100),
    state: clean(r.state).toUpperCase().slice(0, 2),
    zip: clean(r.zip).slice(0, 10),
    firstName: clean(r.firstName).slice(0, 80),
    lastName: clean(r.lastName).slice(0, 80),
    title: clean(r.title).slice(0, 80),
    position: clean(r.position),
    email: clean(r.email).toLowerCase().slice(0, 200),
    phone: toE164(clean(r.phone)) ?? clean(r.phone),
    brandName: clean(r.brandName).slice(0, 200),
    privacyUrl: clean(r.privacyUrl).slice(0, 500),
    termsUrl: clean(r.termsUrl).slice(0, 500),
    description: cleanBlock(r.description).slice(0, 4096),
    messageFlow: cleanBlock(r.messageFlow).slice(0, 2048),
    samples: (Array.isArray(r.samples) ? r.samples : []).map(cleanBlock).filter(Boolean).slice(0, 5).map((s) => s.slice(0, 1024)),
    marketing: r.marketing === true,
    screenshots: (Array.isArray(r.screenshots) ? r.screenshots : [])
      .map((s): A2pScreenshot => {
        const o = s && typeof s === 'object' ? (s as Record<string, unknown>) : {}
        return { url: clean(o.url).slice(0, 500), caption: clean(o.caption).slice(0, LIMITS.caption) }
      })
      .filter((s) => s.url || s.caption)
      .slice(0, LIMITS.screenshots),
  }
}

/** The public page that shows a sub-account's opt-in, step by step, with its screenshots. */
export const optInPageUrl = (accountId: string) => `${publicBase()}/hl/optin/${accountId}`

/** "Acme Fence LLC" → an LLC. Most contractors are LLCs, so that's the guess when the name doesn't say. */
function businessTypeOf(legalName: string): string {
  if (/\b(inc|incorporated|corp|corporation)\b\.?/i.test(legalName)) return 'Corporation'
  if (/\b(llp|lp|partnership|partners)\b/i.test(legalName)) return 'Partnership'
  if (/\bco-?op(erative)?\b/i.test(legalName)) return 'Co-operative'
  return 'Limited Liability Corporation'
}

const originOf = (url: string | null | undefined): string => {
  const s = clean(url)
  if (!s) return ''
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).origin
  } catch {
    return ''
  }
}

function season(now: Date): string {
  const m = now.getMonth()
  return m <= 1 || m === 11 ? 'winter' : m <= 4 ? 'spring' : m <= 7 ? 'summer' : 'fall'
}

/** What the A2P board (/clients/[id]/a2p) knows about a client: onboarding answers plus what staff typed there. */
async function boardFor(clientId: string): Promise<A2pInputs | null> {
  const [client, saved] = await Promise.all([
    prisma.client.findUnique({
      where: { id: clientId },
      select: {
        name: true,
        contactName: true,
        contactEmail: true,
        contactPhone: true,
        address: true,
        siteUrl: true,
        website: true,
        ein: true,
        seoSite: { select: { facts: true } },
        intakes: {
          orderBy: { receivedAt: 'desc' },
          take: 1,
          select: { fullName: true, businessName: true, businessAddress: true, customerPhone: true, leadEmail: true, cities: true, website: true, domainName: true, yearStarted: true, ein: true, mainServices: true, aboutBusiness: true },
        },
      },
    }),
    prisma.appSetting.findUnique({ where: { key: `a2p.client.${clientId}` } }),
  ])
  if (!client) return null
  const { intakes, seoSite, ...c } = client
  const prefill = a2pPrefill({ ...c, intake: intakes[0] ?? null, ...boardFacts(seoSite?.facts) })
  try {
    const values = (JSON.parse(saved?.value ?? '{}') as { values?: Partial<A2pInputs> }).values ?? {}
    for (const [k, v] of Object.entries(values)) if (typeof v === 'string' && v.trim()) (prefill as Record<string, string>)[k] = v.trim()
  } catch {
    // nothing saved on the board
  }
  return prefill
}

type DraftContext = { details: A2pDetails; legal: LegalLinks; formUrls: string[]; smsBox: string | null; marketingBox: string | null; optInUrl: string }

/** The review screen: what's been saved, else everything the Hub already knows, with the campaign copy written for this business. */
export async function a2pDraft(accountId: string, now = new Date()): Promise<DraftContext> {
  const account = await prisma.hlAccount.findUnique({
    where: { id: accountId },
    include: { forms: { where: { archivedAt: null, ghlId: null } }, a2p: true, numbers: { where: { status: 'active' }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] } },
  })
  if (!account) throw new HlInputError('Sub-account not found.')
  // A client's own privacy and terms pages (found in the site's repo, hooked up under Clients) fill blank links.
  const filled = account.clientId ? await fillLegalLinksFromSite(accountId) : null
  const p = readProfile(filled ? (await prisma.hlAccount.findUniqueOrThrow({ where: { id: accountId }, select: { profile: true } })).profile : account.profile)
  const board = account.clientId ? await boardFor(account.clientId) : null
  const business = p.businessName || board?.businessName || account.name
  const legal = resolveLegalLinks(accountId, p)

  // The live consent boxes, as the form shows them.
  const quote = account.forms.find((f) => f.kind === 'form')
  const chat = account.forms.find((f) => f.kind === 'chat')
  const fill = (t: string) => t.replace(/\{\{\s*business\s*\}\}/g, business)
  const boxes = quote ? consentsOf(asSettings(quote.settings)) : []
  const smsBox = boxes.find((b) => b.kind === 'sms')?.text ?? null
  const marketingBox = boxes.find((b) => b.kind === 'marketing')?.text ?? null
  // Where people opt in: the quote form on the client's own site, never a Hub address.
  const formUrls = account.clientId ? await siteFormPages(account.clientId) : []

  const ein = (p.ein || board?.ein || '').replace(/\D/g, '')
  const legalName = p.legalName || board?.legalName || business
  const addr = parseUsAddress(p.address || board?.address)
  const owner = splitName(p.ownerName || p.ownerFirstName || (board?.ownerFirstName ?? ''))
  const email = (p.notifyEmail ?? '').split(/[,;\s]+/).find((e) => e.includes('@')) || board?.contactEmail || ''
  const phone = toE164(p.notifyPhone?.split(',')[0]) ?? toE164(p.businessPhone) ?? toE164(board?.phone) ?? ''
  const website = originOf(p.website) || originOf(board?.domain)
  const marketing = !!marketingBox
  const trade = board?.trade?.trim() ?? ''
  const city = addr.city || board?.city || ''
  const state = addr.state || ''
  const callNumber = prettyPhone(p.businessPhone || account.numbers.find((n) => n.kind === 'local')?.number || '')

  const copy = campaignCopy({
    business,
    trade,
    city,
    state,
    serviceArea: board?.serviceArea ?? '',
    owner: p.ownerFirstName || owner.firstName || '',
    phone: callNumber,
    website,
    reviewLink: p.reviewLink || '',
    formUrls,
    hasChat: !!chat,
    smsBox: smsBox && fill(smsBox),
    marketingBox: marketingBox && fill(marketingBox),
    legal,
    marketing,
    season: season(now),
  })

  const defaults: A2pDetails = {
    path: ein.length === 9 ? 'low_volume' : 'sole_prop',
    legalName,
    businessType: businessTypeOf(legalName),
    ein: ein.length === 9 ? `${ein.slice(0, 2)}-${ein.slice(2)}` : '',
    industry: account.clientId ? 'CONSTRUCTION' : 'PROFESSIONAL_SERVICES',
    website,
    street: addr.street,
    city,
    state,
    zip: addr.zip,
    firstName: owner.firstName ?? '',
    lastName: owner.lastName ?? '',
    title: 'Owner',
    position: 'CEO',
    email,
    phone,
    brandName: business,
    privacyUrl: legal.privacy,
    termsUrl: legal.terms,
    marketing,
    screenshots: [],
    ...copy,
  }
  // What was typed on the review screen before wins over the defaults.
  const details: A2pDetails = { ...defaults }
  const raw = account.a2p?.details
  if (raw && typeof raw === 'object' && Object.keys(raw).length) {
    const saved = cleanDetails(raw)
    for (const [k, v] of Object.entries(saved) as [keyof A2pDetails, A2pDetails[keyof A2pDetails]][]) {
      if (Array.isArray(v) ? v.length : k === 'marketing' || k === 'path' ? true : typeof v === 'string' && v.trim()) (details as Record<string, unknown>)[k] = v
    }
  }
  // A draft written before the business's own policy pages were set still quotes the Hub's: point it at the real ones.
  for (const [doc, url] of [['privacy', details.privacyUrl], ['terms', details.termsUrl]] as const) {
    const hosted = hostedLegalUrl(accountId, doc)
    if (url && url !== hosted) details.messageFlow = details.messageFlow.split(hosted).join(url)
  }
  return { details, legal, formUrls, smsBox: smsBox && fill(smsBox), marketingBox: marketingBox && fill(marketingBox), optInUrl: optInPageUrl(accountId) }
}

/** The campaign's description, opt-in flow and sample messages, in the wording that's been getting contractors approved. */
export function campaignCopy(o: {
  business: string
  trade: string
  city: string
  state: string
  serviceArea: string
  owner: string
  phone: string
  website: string
  reviewLink: string
  formUrls: string[]
  hasChat: boolean
  smsBox: string | null
  marketingBox: string | null
  legal: LegalLinks
  marketing: boolean
  season: string
}): Pick<A2pDetails, 'description' | 'messageFlow' | 'samples'> {
  const B = o.business
  const where = o.city && o.state ? ` in ${o.city}, ${o.state}` : ''
  const what = o.trade ? `${/^[aeiou]/i.test(o.trade) ? 'an' : 'a'} ${o.trade}` : 'a local business'
  const call = o.phone ? `call ${o.phone}` : 'call us'
  const description = [
    `${B} is ${what}${where}${o.serviceArea ? `, serving ${o.serviceArea.replace(/\.$/, '')}` : ''}.`,
    'We text people who asked us for a quote or hired us, and who agreed to texts: replies to quote requests from our website form and chat, a text back when we miss someone’s call, appointment confirmations and reminders, job updates, and a review request after the work is done.',
    o.marketing ? 'Occasional promotions (1 to 2 a month) go only to people who also tick a separate, optional marketing checkbox.' : '',
    'Messages are one to one, typically 4 to 8 a month while a job is active. Anyone can reply STOP to opt out or HELP for help. We never buy, rent or share phone numbers or consent.',
  ]
    .filter(Boolean)
    .join(' ')

  const site = o.website || 'our website'
  const form = `our quote request form${o.formUrls.length ? ` (${o.formUrls.join(', ')})` : ''}${o.hasChat ? ' and chat widget' : ''}`
  const parts = [
    `People opt in on the ${B} website (${site}) through ${form}, which has optional, unchecked consent checkboxes.`,
    o.smsBox ? `The texting box reads: "${o.smsBox}"` : '',
    o.marketingBox ? `A separate, optional box for promotions reads: "${o.marketingBox}"` : '',
    `The Privacy Policy (${o.legal.privacy}) and Terms (${o.legal.terms}) are linked right below the boxes.`,
    `People can also opt in by texting or calling ${B} first, and we reply only about their request. Consent is never a condition of purchase.`,
  ]
  let messageFlow = parts.filter(Boolean).join(' ')
  // Twilio caps this at 2,048 characters: drop the promo box's wording before anything else.
  if (messageFlow.length > 2048) messageFlow = parts.map((p, i) => (i === 2 && p ? 'A separate, optional box covers promotions.' : p)).filter(Boolean).join(' ')

  const samples = [
    `Hi Jennifer, this is ${o.owner || 'the team'} with ${B}. Thanks for your quote request! We'll call you shortly to set up a time. Questions? Reply here or ${call}. Reply STOP to opt out.`,
    `${B}: sorry we missed your call! How can we help? Reply here and we'll get right back to you. Reply STOP to opt out.`,
    `Hi Jennifer, a reminder from ${B}: your estimate is tomorrow at 2:00 PM. Need a different time? Reply here or ${call}.`,
    `Thanks again for choosing ${B}, Jennifer! Would you leave us a quick review? ${o.reviewLink || site} Reply STOP to opt out.`,
    o.marketing
      ? `Hi Jennifer, it's ${o.owner || 'the team'} at ${B}. Our ${o.season} special is on for jobs booked this month. Want a free quote? Reply here or ${call}. Reply STOP to opt out.`
      : '',
  ].filter(Boolean)
  return { description, messageFlow: messageFlow.slice(0, 2048), samples }
}

// ---------------------------------------------------------------------------
// Pre-check: the things reviewers reject for, tested before anything is paid
// ---------------------------------------------------------------------------

const FREE_MAIL = /@(gmail|yahoo|hotmail|outlook|aol|icloud|me|live|msn|proton(mail)?)\.[a-z.]+$/i

/** Public web pages only (and the Hub's own): the server never loads an internal address someone typed. */
function loadable(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    if (u.host === new URL(publicBase()).host) return true
    return /[a-z]/i.test(u.hostname.split('.').pop() ?? '') && u.hostname.includes('.') && !/^\[|^localhost$|\.(local|internal|localhost)$/i.test(u.hostname)
  } catch {
    return false
  }
}

async function load(url: string): Promise<{ ok: boolean; status: number; finalUrl: string; html: string; error: string | null }> {
  if (!loadable(url)) return { ok: false, status: 0, finalUrl: url, html: '', error: 'not a public web address' }
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(12_000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; GenisysHub texting-registration check)' } })
    const html = res.ok ? (await res.text()).slice(0, 600_000) : ''
    return { ok: res.ok, status: res.status, finalUrl: res.url || url, html, error: null }
  } catch (err) {
    return { ok: false, status: 0, finalUrl: url, html: '', error: err instanceof Error ? err.message : String(err) }
  }
}

/** A link that loads as a picture (what a reviewer's browser would show). */
async function isImage(url: string): Promise<boolean> {
  if (!loadable(url)) return false
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(12_000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; GenisysHub texting-registration check)' } })
    await res.body?.cancel()
    return res.ok && /^image\//i.test(res.headers.get('content-type') ?? '')
  } catch {
    return false
  }
}

const hostOf = (u: string) => {
  try {
    return new URL(u).host.toLowerCase()
  } catch {
    return ''
  }
}

/** A page's words, without markup: a site that builds its text with JavaScript has next to none. */
const visibleText = (html: string) =>
  html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Every check reviewers are known to reject for, run against the live pages. Errors block filing; warnings don't. */
export async function a2pPreflight(accountId: string, raw: unknown): Promise<A2pCheck[]> {
  const d = cleanDetails(raw)
  const ctx = await a2pDraft(accountId)
  const checks: A2pCheck[] = detailProblems(d).map((p, i) => ({ key: `detail-${i}`, level: 'error' as const, label: 'Missing or invalid', detail: p }))
  if ((await twilioAccountType().catch(() => null)) === 'Trial')
    checks.push({ key: 'twilio-trial', level: 'error', label: 'Twilio account', detail: 'Twilio is still a free trial, and trial accounts can’t register A2P (or text anyone but verified numbers). Upgrade it in the Twilio Console first, then check again.' })
  else
    await primaryProfile()
      .then((p) => {
        const problem = individualProfileProblem(p)
        if (problem) checks.push({ key: 'twilio-profile', level: 'error', label: 'Genisys’s Twilio profile', detail: problem })
      })
      .catch((err) => {
        // Not set up at all (no Twilio keys) is said elsewhere; a missing primary profile is said here.
        if (err instanceof HlInputError && /primary business profile/.test(err.message)) checks.push({ key: 'twilio-profile', level: 'error', label: 'Genisys’s Twilio profile', detail: err.message })
      })
  const legal = { privacy: d.privacyUrl || ctx.legal.privacy, terms: d.termsUrl || ctx.legal.terms }
  const [site, privacy, terms, shown] = await Promise.all([
    d.website ? load(d.website) : Promise.resolve(null),
    load(legal.privacy),
    load(legal.terms),
    Promise.all(d.screenshots.map((s) => isImage(s.url))),
  ])
  const hlOnSite = !!site?.ok && /\/hl\/(widget\.js|f\/|c\/)/.test(site.html)
  // People sign up somewhere other than a Hell-level form (a booking page, another site's form), shown in screenshots.
  const outside = d.screenshots.length > 0 && !hlOnSite
  const linked = d.messageFlow.includes(ctx.optInUrl)

  const business = (d.path === 'sole_prop' ? d.brandName : ctx.details.brandName || d.legalName).replace(/[,.]?\s*\b(llc|l\.l\.c\.|inc|incorporated|corp|corporation|co|ltd|lp|llp)\b\.?$/i, '').trim()
  if (site) {
    const moved = hostOf(site.finalUrl) !== hostOf(d.website)
    if (!site.ok) checks.push({ key: 'site', level: 'error', label: 'Website', detail: `${d.website} doesn’t load (${site.error ?? `HTTP ${site.status}`}). The registry rejects brands whose site is down, parked or behind a login.` })
    else if (moved && hostOf(site.finalUrl).replace(/^www\./, '') !== hostOf(d.website).replace(/^www\./, ''))
      checks.push({ key: 'site', level: 'error', label: 'Website', detail: `${d.website} redirects to ${site.finalUrl}, a different site. Use the address the business’s own site lives at.` })
    else if (moved) {
      const real = new URL(site.finalUrl).origin
      checks.push({ key: 'site', level: 'warning', label: 'Website', detail: `${d.website} redirects to ${real}. Use that address instead: reviewers fail links that redirect.`, fix: { label: `Use ${real}`, patch: { website: real } } })
    }
    else checks.push({ key: 'site', level: 'ok', label: 'Website', detail: `${d.website} loads.` })
    if (site.ok && business && !site.html.toLowerCase().includes(business.toLowerCase()))
      checks.push({ key: 'site-name', level: 'warning', label: 'Business name on the site', detail: `Couldn’t find “${business}” on the page. Fine if the site builds its text with JavaScript, but reviewers reject sites that show a different name.` })
    // Reviewers look for the consent boxes where people actually sign up: the site itself.
    if (site.ok && visibleText(site.html).length >= 300 && !hlOnSite) {
      if (outside && linked) checks.push({ key: 'site-form', level: 'ok', label: 'Where people opt in', detail: 'Not on the site’s own pages, so the opt-in page shows reviewers each step in screenshots.' })
      else
        checks.push({ key: 'site-form', level: 'warning', label: 'Form on the website', detail: 'The website doesn’t show the Hell-level form or chat yet. Reviewers look for the consent boxes on the site, so put the form there first, or make sure the site’s own form has the same two boxes. If people sign up somewhere a reviewer can’t see at a glance (a booking page, another site), add screenshots of each step.' })
    }
  }
  if (d.screenshots.length) {
    const broken = d.screenshots.map((_, i) => (shown[i] ? 0 : i + 1)).filter(Boolean)
    if (broken.length) checks.push({ key: 'screenshots', level: 'warning', label: 'Screenshots', detail: `Screenshot ${broken.join(', ')} doesn’t load as a picture, so reviewers would see a broken image. Use a direct link to the image file.` })
    else if (!linked)
      checks.push({ key: 'screenshots', level: 'warning', label: 'Screenshots', detail: `“How people opt in” doesn’t link the opt-in page (${ctx.optInUrl}), so reviewers won’t find the screenshots.`, fix: { label: 'Add the link', patch: { messageFlow: withOptInLink(d.messageFlow, ctx.optInUrl) } } })
    else checks.push({ key: 'screenshots', level: 'ok', label: 'Screenshots', detail: `All ${d.screenshots.length} load, and “How people opt in” links the page that shows them.` })
  }

  // Pages built with JavaScript can't be read here; say so rather than call them wrong.
  const unreadable = (html: string) => visibleText(html).length < 300
  if (!privacy.ok) checks.push({ key: 'privacy', level: 'error', label: 'Privacy policy', detail: `${legal.privacy} doesn’t load (${privacy.error ?? `HTTP ${privacy.status}`}).` })
  else if (unreadable(privacy.html)) checks.push({ key: 'privacy', level: 'warning', label: 'Privacy policy', detail: `${legal.privacy} loads, but its text is built with JavaScript, so it couldn’t be checked. Make sure it says phone numbers and texting consent are never shared.` })
  else if (!/\b(sms|text messag)/i.test(privacy.html) || !/\b(no|not|never)\b[^.]{0,120}\b(sell|sold|shar|rent)/i.test(visibleText(privacy.html)))
    checks.push({ key: 'privacy', level: 'warning', label: 'Privacy policy', detail: 'It should say texting consent and phone numbers are never sold or shared with third parties.' })
  else checks.push({ key: 'privacy', level: 'ok', label: 'Privacy policy', detail: 'Loads, and covers texting.' })

  if (!terms.ok) checks.push({ key: 'terms', level: 'error', label: 'Terms', detail: `${legal.terms} doesn’t load (${terms.error ?? `HTTP ${terms.status}`}).` })
  else if (unreadable(terms.html)) checks.push({ key: 'terms', level: 'warning', label: 'Terms', detail: `${legal.terms} loads, but its text is built with JavaScript, so it couldn’t be checked. Make sure it covers STOP, HELP and “message and data rates may apply”.` })
  else if (!/\bSTOP\b/.test(terms.html) || !/\bHELP\b/.test(terms.html) || !/rates may apply/i.test(terms.html))
    checks.push({ key: 'terms', level: 'warning', label: 'Terms', detail: 'The texting terms should cover STOP, HELP and “message and data rates may apply”.' })
  else checks.push({ key: 'terms', level: 'ok', label: 'Terms', detail: 'Loads, with STOP, HELP and rates.' })

  const account = await prisma.hlAccount.findUnique({ where: { id: accountId }, include: { forms: { where: { archivedAt: null, ghlId: null, kind: 'form' } } } })
  // A client's registration points only at the client's own site: reviewers reject a Hub (or Render) address.
  if (account?.clientId) {
    if (isHubUrl(legal.privacy) || isHubUrl(legal.terms))
      checks.push({ key: 'client-pages', level: 'error', label: 'The client’s own pages', detail: 'The privacy policy and terms have to be pages on the client’s own website; the Hub’s won’t pass review. Hell-level finds /privacy and /terms in the site’s repo (Clients → the site), or put the links in above.' })
    if ([...d.messageFlow.matchAll(/https?:\/\/[^\s"')]+/g)].some((m) => isHubUrl(m[0])))
      checks.push({ key: 'client-flow', level: 'error', label: 'Opt-in links', detail: '“How people opt in” links a Hub page. Point it at the quote form on the client’s own website.' })
  }
  const quote = account?.forms[0]
  const boxes = quote ? consentsOf(asSettings(quote.settings)) : []
  const smsBox = boxes.find((b) => b.kind === 'sms')
  // A sign-up outside Hell-level has its own boxes, which the screenshots show; the Hell-level form isn't what reviewers see.
  if (outside) checks.push({ key: 'form', level: 'ok', label: 'Opt-in form', detail: 'People sign up on a form outside Hell-level. Make sure “How people opt in” quotes its consent boxes word for word, as the screenshots show them.' })
  else if (!quote || !smsBox) checks.push({ key: 'form', level: 'warning', label: 'Opt-in form', detail: 'No Hell-level form with a texting consent box. Make sure the form on the website has one (two optional, unchecked boxes).' })
  else if (smsBox.required) checks.push({ key: 'form', level: 'error', label: 'Opt-in form', detail: `Turn off “Required” on the texting consent box in “${quote.name}”: consent can’t be a condition, and a required box gets rejected.` })
  else checks.push({ key: 'form', level: 'ok', label: 'Opt-in form', detail: `“${quote.name}” has an optional, unchecked texting box.` })
  if (!outside && d.marketing && !boxes.some((b) => b.kind === 'marketing'))
    checks.push({ key: 'marketing', level: 'error', label: 'Promotions', detail: 'The campaign includes promotions, but the form has no separate marketing box. Add it to the form, or untick promotions and drop the promo sample.' })
  if (!outside && ctx.smsBox && !d.messageFlow.includes(ctx.smsBox))
    checks.push({ key: 'verbatim', level: 'warning', label: 'Opt-in wording', detail: '“How people opt in” should quote the form’s texting box word for word.' })

  if (d.samples.length) {
    if (business && d.samples.some((s) => !s.toLowerCase().includes(business.toLowerCase())))
      checks.push({ key: 'samples', level: 'warning', label: 'Sample messages', detail: `Every sample should name “${business}”, or reviewers can’t tell who’s texting.` })
    if (!d.samples.some((s) => /\bSTOP\b/.test(s))) checks.push({ key: 'stop', level: 'warning', label: 'Sample messages', detail: 'At least one sample should say “Reply STOP to opt out”.' })
  }
  if (FREE_MAIL.test(d.email)) checks.push({ key: 'email', level: 'warning', label: 'Email', detail: `${d.email} is a free address. Accepted, but an email on the business’s own domain gets approved more smoothly.` })
  if (d.path === 'sole_prop' && d.phone) {
    const ours = await prisma.hlPhoneNumber.findFirst({ where: { number: d.phone } })
    if (ours || d.phone === process.env.TWILIO_FROM_NUMBER)
      checks.push({ key: 'otp-phone', level: 'error', label: 'Owner’s cell', detail: 'That’s a Twilio number. The registry texts the owner’s own cell (not a Twilio or Google Voice number) and they reply YES.' })
  }
  return checks
}

// ---------------------------------------------------------------------------
// Twilio
// ---------------------------------------------------------------------------

/** A Twilio error in words, with its code for looking it up. */
function problem(err: unknown): string {
  if (err instanceof StepError || err instanceof HlInputError) return err.message
  const e = err as { message?: string; code?: number; status?: number }
  return `${e.message ?? String(err)}${e.code ? ` (Twilio ${e.code})` : ''}`
}

/** 4xx from Twilio means the request itself is wrong; anything else is worth retrying. */
const refused = (err: unknown) => {
  const s = (err as { status?: number }).status
  return err instanceof StepError || err instanceof HlInputError || (typeof s === 'number' && s >= 400 && s < 500)
}

/** What a noncompliant Trust Hub evaluation says is wrong. */
function evaluationProblems(results: unknown[]): string {
  const out: string[] = []
  for (const r of results as { friendly_name?: string; requirement_friendly_name?: string; passed?: boolean; failure_reason?: string; invalid?: { friendly_name?: string; failure_reason?: string }[] }[]) {
    if (r.passed) continue
    const bad = (r.invalid ?? []).map((i) => [i.friendly_name, i.failure_reason].filter(Boolean).join(': ')).filter(Boolean)
    out.push(`${r.requirement_friendly_name || r.friendly_name || 'Requirement'}: ${bad.length ? bad.join('; ') : r.failure_reason || 'missing'}`)
  }
  return out.join(' · ') || 'Twilio says the profile is incomplete.'
}

/** A brand's or campaign's errors array, as text. */
function errorsText(errors: unknown, fallback: string): string {
  const list = Array.isArray(errors) ? errors : []
  const lines = list
    .map((e) => {
      if (!e || typeof e !== 'object') return String(e)
      const o = e as Record<string, unknown>
      const text = o.description ?? o.message ?? o.error_message ?? o.reason
      const code = o.error_code ?? o.code
      const fields = Array.isArray(o.fields) && o.fields.length ? ` [${o.fields.join(', ')}]` : ''
      return typeof text === 'string' ? `${text}${fields}${code ? ` (${code})` : ''}` : JSON.stringify(o)
    })
    .filter(Boolean)
  return lines.join(' · ') || fallback
}

const BRAND_FEEDBACK: Record<string, string> = {
  TAX_ID: 'The legal name and EIN don’t match IRS records. Use the name exactly as it is on the EIN letter (CP 575), including LLC or Inc.',
  STOCK_SYMBOL: 'The stock exchange or ticker didn’t check out.',
  NONPROFIT: 'The nonprofit status didn’t check out.',
  GOVERNMENT_ENTITY: 'The government status didn’t check out.',
  OTHERS: 'The registry couldn’t verify the business.',
}

async function assigned(list: () => Promise<{ objectSid: string }[]>): Promise<Set<string>> {
  return new Set((await list()).map((a) => a.objectSid))
}

/**
 * Is this Genisys's own business (the EIN on its primary business profile)?
 * Twilio wants an ISV's own brand on the primary profile itself, not on a
 * client profile, so Lead Genisys registers that way and clients don't.
 */
async function isOwnBusiness(client: TwilioClient, primarySid: string, ein: string): Promise<boolean> {
  const digits = ein.replace(/\D/g, '')
  if (digits.length !== 9) return false
  const hub = client.trusthub.v1
  for (const a of await hub.customerProfiles(primarySid).customerProfilesEntityAssignments.list({ limit: 50 })) {
    if (!a.objectSid.startsWith('IT')) continue
    const user = await hub.endUsers(a.objectSid).fetch().catch(() => null)
    const number = user?.type === 'customer_profile_business_information' ? String((user.attributes as Record<string, unknown>)?.business_registration_number ?? '') : ''
    if (number.replace(/\D/g, '') === digits) return true
  }
  return false
}

/** Step 1a: the business's customer profile in Trust Hub, made or brought up to date with the details. */
async function ensureCustomerProfile(client: TwilioClient, row: HlA2p, d: A2pDetails, meta: Meta): Promise<string> {
  const hub = client.trusthub.v1
  const sole = d.path === 'sole_prop'
  const [owner, settings] = await Promise.all([primaryProfile(client), readTwilioSettings()])
  const individual = individualProfileProblem(owner)
  if (individual) throw new StepError(individual, 'profile')
  const primary = owner.sid
  const email = settings.notificationEmail?.trim() || 'alex@leadgenisys.com'
  // Genisys's own texting: the brand goes on the primary profile, which is never edited from here.
  if (!sole && ((meta.own && row.customerProfileSid === primary) || (!row.brandSid && (await isOwnBusiness(client, primary, d.ein))))) {
    if (row.customerProfileSid !== primary) {
      // A trust bundle made for an earlier client profile can't carry over.
      await prisma.hlA2p.update({ where: { id: row.id }, data: { customerProfileSid: primary, trustProductSid: null } })
      delete meta.trustEndUser
    }
    meta.own = true
    return primary
  }
  let sid = row.customerProfileSid
  if (!sid) {
    const made = await hub.customerProfiles.create({
      friendlyName: `${(sole ? d.brandName : d.legalName).slice(0, 40)} · Hell-level ${row.accountId.slice(-6)}`,
      email,
      policySid: sole ? POLICY.starterProfile : POLICY.secondaryProfile,
    })
    sid = made.sid
    await prisma.hlA2p.update({ where: { id: row.id }, data: { customerProfileSid: sid } })
  }
  const profile = await hub.customerProfiles(sid).fetch()
  const editable = profile.status === 'draft' || profile.status === 'twilio-rejected'
  // Twilio locks a profile once it's submitted or approved (error 70002 on any change to what's in it).
  if (!editable) return sid

  // The people and business on it, while it can still change (a new or Twilio-rejected profile).
  const upsertEndUser = async (key: 'businessEndUser' | 'repEndUser' | 'starterEndUser', type: string, attributes: Record<string, unknown>) => {
    const existing = meta[key]
    if (existing) {
      await hub.endUsers(existing).update({ attributes })
      return existing
    }
    const made = await hub.endUsers.create({ friendlyName: `${type} · ${row.accountId.slice(-6)}`, type, attributes })
    meta[key] = made.sid
    return made.sid
  }
  const entities: string[] = []
  if (sole) {
    entities.push(await upsertEndUser('starterEndUser', 'starter_customer_profile_information', { first_name: d.firstName, last_name: d.lastName, email: d.email, phone_number: d.phone }))
  } else {
    entities.push(
      await upsertEndUser('businessEndUser', 'customer_profile_business_information', {
        business_name: d.legalName,
        business_type: d.businessType,
        business_registration_identifier: 'EIN',
        business_registration_number: d.ein,
        business_identity: 'direct_customer',
        business_industry: d.industry,
        business_regions_of_operation: 'USA_AND_CANADA',
        website_url: d.website,
      }),
    )
    entities.push(
      await upsertEndUser('repEndUser', 'authorized_representative_1', {
        first_name: d.firstName,
        last_name: d.lastName,
        email: d.email,
        phone_number: d.phone,
        business_title: d.title,
        job_position: d.position,
      }),
    )
  }
  const address = { customerName: sole ? `${d.firstName} ${d.lastName}` : d.legalName, street: d.street, city: d.city, region: d.state, postalCode: d.zip }
  if (meta.addressSid) await client.addresses(meta.addressSid).update(address)
  else meta.addressSid = (await client.addresses.create({ ...address, isoCountry: 'US', friendlyName: `Hell-level ${row.accountId.slice(-6)}` })).sid
  if (!meta.documentSid) {
    meta.documentSid = (await hub.supportingDocuments.create({ friendlyName: `Address · ${row.accountId.slice(-6)}`, type: 'customer_profile_address', attributes: { address_sids: meta.addressSid } })).sid
  }
  entities.push(meta.documentSid, primary)
  await prisma.hlA2p.update({ where: { id: row.id }, data: { meta: asJson(meta) } })

  // Exactly one profile belongs on it: Genisys's primary. Anything else (a client profile picked by mistake) comes off.
  const current = await hub.customerProfiles(sid).customerProfilesEntityAssignments.list({ limit: 50 })
  for (const a of current) if (a.objectSid.startsWith('BU') && a.objectSid !== primary) await hub.customerProfiles(sid).customerProfilesEntityAssignments(a.sid).remove()
  const have = new Set(current.map((a) => a.objectSid))
  for (const objectSid of entities) if (!have.has(objectSid)) await hub.customerProfiles(sid).customerProfilesEntityAssignments.create({ objectSid })
  const evaluation = await hub.customerProfiles(sid).customerProfilesEvaluations.create({ policySid: sole ? POLICY.starterProfile : POLICY.secondaryProfile })
  if (evaluation.status !== 'compliant') throw new StepError(`Twilio’s business profile check: ${evaluationProblems(evaluation.results)}`, 'profile')
  await hub.customerProfiles(sid).update({ status: 'pending-review' })
  return sid
}

/** Step 1b: the A2P trust bundle (sole proprietor: brand name and the cell the registry texts). */
async function ensureTrustProduct(client: TwilioClient, row: HlA2p, d: A2pDetails, meta: Meta, profileSid: string): Promise<string> {
  const hub = client.trusthub.v1
  const sole = d.path === 'sole_prop'
  const email = (await readTwilioSettings()).notificationEmail?.trim() || 'alex@leadgenisys.com'
  let sid = row.trustProductSid
  if (!sid) {
    const made = await hub.trustProducts.create({ friendlyName: `A2P · ${(sole ? d.brandName : d.legalName).slice(0, 40)} · ${row.accountId.slice(-6)}`, email, policySid: sole ? POLICY.soleTrust : POLICY.a2pTrust })
    sid = made.sid
    await prisma.hlA2p.update({ where: { id: row.id }, data: { trustProductSid: sid } })
  }
  // Submitted or approved, Twilio has locked it (70002): leave it as it is.
  const bundle = await hub.trustProducts(sid).fetch()
  if (bundle.status !== 'draft' && bundle.status !== 'twilio-rejected') return sid
  const attributes = sole ? { brand_name: d.brandName, mobile_phone_number: d.phone } : { company_type: 'private' }
  if (meta.trustEndUser) await hub.endUsers(meta.trustEndUser).update({ attributes })
  else meta.trustEndUser = (await hub.endUsers.create({ friendlyName: `A2P profile · ${row.accountId.slice(-6)}`, type: sole ? 'sole_proprietor_information' : 'us_a2p_messaging_profile_information', attributes })).sid
  await prisma.hlA2p.update({ where: { id: row.id }, data: { meta: asJson(meta) } })
  const have = await assigned(() => hub.trustProducts(sid).trustProductsEntityAssignments.list({ limit: 50 }))
  for (const objectSid of [meta.trustEndUser, profileSid]) if (!have.has(objectSid)) await hub.trustProducts(sid).trustProductsEntityAssignments.create({ objectSid })
  const evaluation = await hub.trustProducts(sid).trustProductsEvaluations.create({ policySid: sole ? POLICY.soleTrust : POLICY.a2pTrust })
  if (evaluation.status !== 'compliant') throw new StepError(`Twilio’s A2P profile check: ${evaluationProblems(evaluation.results)}`, 'trust')
  await hub.trustProducts(sid).update({ status: 'pending-review' })
  return sid
}

/** Step 2: the brand (charged). An existing brand on this profile is used instead of paying for another. */
async function registerBrand(client: TwilioClient, row: HlA2p, d: A2pDetails) {
  const m = client.messaging.v1
  const existing = (await m.brandRegistrations.list({ limit: 1000 })).find((b) => b.customerProfileBundleSid === row.customerProfileSid)
  return (
    existing ??
    (await m.brandRegistrations.create({
      customerProfileBundleSid: row.customerProfileSid!,
      a2PProfileBundleSid: row.trustProductSid!,
      brandType: d.path === 'sole_prop' ? 'SOLE_PROPRIETOR' : 'STANDARD',
      skipAutomaticSecVet: d.path === 'low_volume',
      mock: false,
    }))
  )
}

/** The local numbers that belong on the campaign (a sole proprietor's campaign takes one). */
async function campaignNumbers(accountId: string, path: string) {
  const locals = await prisma.hlPhoneNumber.findMany({ where: { accountId, status: 'active', kind: 'local', providerSid: { not: null } }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] })
  return path === 'sole_prop' ? locals.slice(0, 1) : locals
}

/** Put the local numbers on the Messaging Service (a number can only be on one). */
async function attachNumbers(client: TwilioClient, row: HlA2p, meta: Meta): Promise<void> {
  const ms = client.messaging.v1.services(row.messagingServiceSid!)
  const wanted = await campaignNumbers(row.accountId, row.path)
  const on = new Set((await ms.phoneNumbers.list({ limit: 400 })).map((p) => p.sid))
  for (const n of wanted) {
    if (on.has(n.providerSid!)) continue
    try {
      await ms.phoneNumbers.create({ phoneNumberSid: n.providerSid! })
    } catch (err) {
      throw new StepError(`${prettyPhone(n.number)} couldn’t join the campaign: ${problem(err)}. If it’s on another Messaging Service in Twilio, remove it there first.`, 'numbers')
    }
  }
  meta.attached = wanted.map((n) => n.providerSid!)
}

/** Step 3: the Messaging Service, its numbers and the campaign (charged). An existing campaign is used instead of paying for another. */
async function fileCampaign(client: TwilioClient, row: HlA2p, d: A2pDetails, meta: Meta): Promise<{ sid: string; status: string }> {
  const m = client.messaging.v1
  const account = await prisma.hlAccount.findUnique({ where: { id: row.accountId }, select: { name: true, profile: true } })
  const legal = resolveLegalLinks(row.accountId, readProfile(account?.profile))
  let ms = row.messagingServiceSid
  if (!ms) {
    const friendlyName = `Hell-level A2P · ${(account?.name ?? '').slice(0, 30)} · ${row.accountId.slice(-6)}`
    // Inbound texts keep going to the number's own webhook (the Hub), not the service's.
    ms = (await m.services.list({ limit: 1000 })).find((s) => s.friendlyName === friendlyName)?.sid ?? (await m.services.create({ friendlyName, useInboundWebhookOnNumber: true })).sid
    await prisma.hlA2p.update({ where: { id: row.id }, data: { messagingServiceSid: ms } })
    row = { ...row, messagingServiceSid: ms }
  }
  await attachNumbers(client, row, meta)
  if (!meta.attached?.length) throw new StepError('This sub-account has no local number to register. Buy one first (Phone Numbers → Buy a number → Local).', 'numbers')

  const existing = (await m.services(ms).usAppToPerson.list({ limit: 20 }))[0]
  if (existing) return { sid: existing.sid, status: existing.campaignStatus }

  let usecase = d.path === 'sole_prop' ? 'SOLE_PROPRIETOR' : d.path === 'low_volume' ? 'LOW_VOLUME' : 'MIXED'
  try {
    const offered = (await m.services(ms).usAppToPersonUsecases.fetch({ brandRegistrationSid: row.brandSid! })).usAppToPersonUsecases.map((u: { code?: string }) => u.code)
    if (!offered.includes(usecase)) usecase = (['LOW_VOLUME', 'MIXED', 'CUSTOMER_CARE'].find((c) => offered.includes(c)) as string | undefined) ?? usecase
  } catch {
    // keep the planned use case; Twilio says why if it's not allowed
  }
  meta.usecase = usecase
  const samples = d.samples.slice(0, 5)
  const campaign = await m.services(ms).usAppToPerson.create({
    brandRegistrationSid: row.brandSid!,
    description: d.description,
    messageFlow: d.messageFlow,
    messageSamples: samples,
    usAppToPersonUsecase: usecase,
    hasEmbeddedLinks: samples.some((s) => /https?:\/\/|www\.|\.(com|net|org|io|co)\b/i.test(s)),
    hasEmbeddedPhone: samples.some((s) => /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.test(s)),
    subscriberOptIn: true,
    ageGated: false,
    directLending: false,
    privacyPolicyUrl: d.privacyUrl || legal.privacy,
    termsAndConditionsUrl: d.termsUrl || legal.terms,
    xTwilioApiVersion: 'v1.2',
  })
  return { sid: campaign.sid, status: campaign.campaignStatus }
}

/** A rejected campaign, edited and resubmitted in place (Twilio charges the review once per campaign). */
async function resubmitCampaign(client: TwilioClient, row: HlA2p, d: A2pDetails, meta: Meta, now: Date) {
  const account = await prisma.hlAccount.findUnique({ where: { id: row.accountId }, select: { profile: true } })
  const legal = resolveLegalLinks(row.accountId, readProfile(account?.profile))
  const samples = d.samples.slice(0, 5)
  const updated = await client.messaging.v1
    .services(row.messagingServiceSid!)
    .usAppToPerson(row.campaignSid!)
    .update({
      description: d.description,
      messageFlow: d.messageFlow,
      messageSamples: samples,
      hasEmbeddedLinks: samples.some((s) => /https?:\/\/|www\.|\.(com|net|org|io|co)\b/i.test(s)),
      hasEmbeddedPhone: samples.some((s) => /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.test(s)),
      ageGated: false,
      directLending: false,
      privacyPolicyUrl: d.privacyUrl || legal.privacy,
      termsAndConditionsUrl: d.termsUrl || legal.terms,
      xTwilioApiVersion: 'v1.2',
    })
  meta.resubmittedAt = now.toISOString()
  meta.resubmitStatus = updated.campaignStatus
  meta.resubmits = (meta.resubmits ?? 0) + 1
  return updated
}

/**
 * Where a resubmitted campaign stands. Twilio only sends an API edit back to
 * the carriers on accounts in its private beta for API campaign edits; on
 * others it keeps the new wording but leaves the campaign rejected, and the
 * new review starts from the Console's Edit Campaign → Update. The watch on
 * rejected campaigns (advanceA2p) notices when it does.
 */
function afterResubmit(status: string, sid: string): Prisma.HlA2pUpdateInput {
  if (status !== 'FAILED') return { stage: 'campaign', campaignStatus: 'PENDING' }
  return {
    stage: 'failed',
    campaignStatus: 'FAILED',
    note: `Twilio saved the fix but didn’t send the campaign back for review: it only does that from its Console for this account (editing campaigns through its API is a private beta). In the Twilio Console, open Messaging → Regulatory compliance → Campaigns, click campaign ${sid}, then Edit Campaign → Update. Hell-level notices the new review by itself.`,
  }
}

// ---------------------------------------------------------------------------
// The registration's life
// ---------------------------------------------------------------------------

async function claim(id: string, now: Date): Promise<boolean> {
  const r = await prisma.hlA2p.updateMany({ where: { id, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] }, data: { lockedUntil: new Date(now.getTime() + LOCK_MS) } })
  return r.count === 1
}

/** The local numbers' texting status follows the registration (it's what textingReady and the badges read). */
async function mirrorNumbers(row: HlA2p): Promise<void> {
  const meta = readMeta(row.meta)
  const attached = new Set(meta.attached ?? [])
  const status = (stage: string, on: boolean) =>
    stage === 'approved' ? (on ? 'approved' : 'none') : stage === 'failed' ? 'rejected' : (ACTIVE_STAGES as string[]).includes(stage) ? 'in_review' : 'none'
  const locals = await prisma.hlPhoneNumber.findMany({ where: { accountId: row.accountId, kind: 'local', status: 'active' } })
  for (const n of locals) {
    const on = attached.has(n.providerSid ?? '')
    const next = { verificationStatus: status(row.stage, on), verificationNote: row.stage === 'failed' ? row.note : null, verificationAt: row.filedAt }
    if (n.verificationStatus !== next.verificationStatus || n.verificationNote !== next.verificationNote || +(n.verificationAt ?? 0) !== +(next.verificationAt ?? 0))
      await prisma.hlPhoneNumber.update({ where: { id: n.id }, data: next })
  }
}

/** The policy links being filed become the Business Profile's, so the forms and the registration point at the same pages. */
async function saveLegalLinks(accountId: string, d: A2pDetails): Promise<void> {
  const account = await prisma.hlAccount.findUnique({ where: { id: accountId }, select: { profile: true } })
  const profile = readProfile(account?.profile)
  const own = (url: string, doc: 'privacy' | 'terms') => (url === hostedLegalUrl(accountId, doc) ? '' : url)
  const privacyUrl = own(d.privacyUrl, 'privacy')
  const termsUrl = own(d.termsUrl, 'terms')
  if ((profile.privacyUrl ?? '') === privacyUrl && (profile.termsUrl ?? '') === termsUrl) return
  await prisma.hlAccount.update({ where: { id: accountId }, data: { profile: asJson({ ...profile, privacyUrl, termsUrl }) } })
}

export async function a2pView(accountId: string): Promise<A2pView | null> {
  const row = await prisma.hlA2p.findUnique({ where: { accountId } })
  if (!row) return null
  const meta = readMeta(row.meta)
  const d = cleanDetails(row.details)
  const attached = meta.attached?.length ? await prisma.hlPhoneNumber.findMany({ where: { providerSid: { in: meta.attached } }, select: { number: true } }) : []
  return {
    path: row.path as A2pPath,
    stage: row.stage as A2pStage,
    brandStatus: row.brandStatus,
    identityStatus: row.identityStatus,
    campaignStatus: row.campaignStatus,
    note: row.note,
    filedAt: row.filedAt?.toISOString() ?? null,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    checkedAt: row.checkedAt?.toISOString() ?? null,
    otpPhone: row.path === 'sole_prop' ? d.phone || null : null,
    numbers: attached.map((n) => n.number),
    own: !!meta.own,
    rejectedAt: row.stage === 'failed' ? (meta.rejectedAt ?? null) : null,
  }
}

/**
 * What Twilio itself has on file for the brand and campaign, for when the
 * summary isn't enough: is the fix there, and when did Twilio last change it.
 */
export async function a2pTwilio(accountId: string, deps: Deps = {}): Promise<Record<string, unknown> | null> {
  const row = await prisma.hlA2p.findUnique({ where: { accountId } })
  if (!row) return null
  const client = deps.client ?? (await twilioClient())
  const m = client.messaging.v1
  const out: Record<string, unknown> = { meta: readMeta(row.meta) }
  if (row.brandSid) {
    try {
      const b = await m.brandRegistrations(row.brandSid).fetch()
      out.brand = { sid: b.sid, status: b.status, identityStatus: b.identityStatus, failureReason: b.failureReason, errors: b.errors, feedback: b.brandFeedback, created: b.dateCreated, updated: b.dateUpdated }
    } catch (err) {
      out.brand = { error: problem(err) }
    }
  }
  if (row.campaignSid && row.messagingServiceSid) {
    try {
      const c = await m.services(row.messagingServiceSid).usAppToPerson(row.campaignSid).fetch()
      out.campaign = {
        sid: c.sid,
        campaignId: c.campaignId,
        status: c.campaignStatus,
        errors: c.errors,
        created: c.dateCreated,
        updated: c.dateUpdated,
        usecase: c.usAppToPersonUsecase,
        description: c.description,
        messageFlow: c.messageFlow,
        samples: c.messageSamples,
        privacyPolicyUrl: c.privacyPolicyUrl,
        termsAndConditionsUrl: c.termsAndConditionsUrl,
      }
    } catch (err) {
      out.campaign = { error: problem(err) }
    }
  }
  return out
}

/**
 * File (or fix and refile) the registration. The free Trust Hub steps run
 * now; the paid brand follows on the next scheduler pass. A rejected brand
 * or campaign is resubmitted with the new details.
 */
export async function fileA2p(accountId: string, raw: unknown, by: string, deps: Deps = {}): Promise<A2pView> {
  const now = deps.now ?? new Date()
  const d = cleanDetails(raw)
  const problems = detailProblems(d)
  if (problems.length) throw new HlInputError(problems.join(' '))
  const local = await prisma.hlPhoneNumber.count({ where: { accountId, status: 'active', kind: 'local' } })
  if (!local) throw new HlInputError('Buy a local number first: A2P registers the sub-account’s local numbers.')
  const client = deps.client ?? (await twilioClient())
  await saveLegalLinks(accountId, d)

  let row = await prisma.hlA2p.upsert({ where: { accountId }, create: { accountId, path: d.path, details: asJson(d) }, update: {} })
  if (row.stage === 'approved') throw new HlInputError('This sub-account’s A2P registration is already approved.')
  if ((ACTIVE_STAGES as string[]).includes(row.stage)) throw new HlInputError('The registration is already with Twilio. Use “Check status”.')
  if (!(await claim(row.id, now))) throw new HlInputError('Hell-level is already working on this registration. Try again in a minute.')

  let meta = readMeta(row.meta)
  delete meta.rejectedAt
  // A different kind of registration (say, no EIN after all) starts over with new Trust Hub records.
  if (row.path !== d.path && (row.customerProfileSid || row.brandSid)) {
    meta = {}
    row = await prisma.hlA2p.update({
      where: { id: row.id },
      data: { customerProfileSid: null, trustProductSid: null, brandSid: null, brandStatus: null, identityStatus: null, messagingServiceSid: null, campaignSid: null, campaignStatus: null, meta: {} },
    })
  }
  row = await prisma.hlA2p.update({ where: { id: row.id }, data: { path: d.path, details: asJson(d), note: null, filedBy: by, filedAt: now } })
  try {
    // The brand passed and only the carriers turned the campaign down: the profile and bundles behind it are
    // approved (and locked), so the fix goes straight to the campaign.
    if (row.campaignSid && row.campaignStatus === 'FAILED' && row.brandSid && row.brandStatus !== 'FAILED') {
      const updated = await resubmitCampaign(client, row, d, meta, now)
      const data = afterResubmit(updated.campaignStatus, row.campaignSid)
      if (data.stage === 'failed') meta.failedStep = 'campaign'
      else delete meta.failedStep
      row = await prisma.hlA2p.update({ where: { id: row.id }, data: { ...data, meta: asJson(meta), checkedAt: now, lockedUntil: null } })
      await mirrorNumbers(row)
      return (await a2pView(accountId))!
    }
    const profileSid = await ensureCustomerProfile(client, row, d, meta)
    row = { ...(await prisma.hlA2p.findUniqueOrThrow({ where: { id: row.id } })), customerProfileSid: profileSid }
    const trustSid = await ensureTrustProduct(client, row, d, meta, profileSid)
    row = { ...row, trustProductSid: trustSid }

    let data: Prisma.HlA2pUpdateInput
    if (row.brandSid && row.brandStatus === 'FAILED') {
      await client.messaging.v1.brandRegistrations(row.brandSid).update()
      data = { stage: 'brand', brandStatus: 'PENDING' }
    } else if (row.campaignSid && row.campaignStatus === 'FAILED') {
      data = afterResubmit((await resubmitCampaign(client, row, d, meta, now)).campaignStatus, row.campaignSid)
    } else if (row.campaignSid) {
      data = { stage: 'campaign' }
    } else if (row.brandSid) {
      data = { stage: 'brand' }
    } else {
      data = { stage: 'profile', nextAt: new Date(now.getTime() + BRAND_PAUSE_MS) }
    }
    if (data.stage === 'failed') meta.failedStep = 'campaign'
    else delete meta.failedStep
    row = await prisma.hlA2p.update({ where: { id: row.id }, data: { ...data, meta: asJson(meta), checkedAt: now, lockedUntil: null } })
  } catch (err) {
    meta.failedStep = err instanceof StepError ? err.step : (meta.failedStep ?? 'profile')
    row = await prisma.hlA2p.update({ where: { id: row.id }, data: { stage: 'failed', note: problem(err), meta: asJson(meta), checkedAt: now, lockedUntil: null } })
    console.warn(`[hell-level] A2P filing for ${accountId} stopped: ${row.note}`)
  }
  await mirrorNumbers(row)
  return (await a2pView(accountId))!
}

/** Move a registration on: register the brand, notice the registry's answer, file the campaign, notice the carriers'. */
export async function advanceA2p(accountId: string, deps: Deps = {}): Promise<A2pView | null> {
  const now = deps.now ?? new Date()
  let row = await prisma.hlA2p.findUnique({ where: { accountId } })
  // A campaign the carriers turned down can also be fixed and resubmitted in Twilio's console: keep watching it.
  const rejectedCampaign = row?.stage === 'failed' && row.campaignStatus === 'FAILED' && !!row.campaignSid && !!row.messagingServiceSid
  if (!row || row.stage === 'draft' || (row.stage === 'failed' && !rejectedCampaign)) return row ? a2pView(accountId) : null
  if (!(await claim(row.id, now))) return a2pView(accountId)
  const client = deps.client ?? (await twilioClient())
  const meta = readMeta(row.meta)
  const d = cleanDetails(row.details)
  const data: Prisma.HlA2pUpdateInput = { checkedAt: now }
  try {
    if (row.stage === 'profile') {
      if (!row.nextAt || row.nextAt <= now) {
        const brand = await registerBrand(client, row, d)
        Object.assign(data, { stage: 'brand', brandSid: brand.sid, brandStatus: brand.status, identityStatus: brand.identityStatus ?? null })
        console.log(`[hell-level] A2P brand ${brand.sid} registered for ${accountId}`)
      }
    } else if (row.stage === 'brand' || row.stage === 'otp') {
      const brand = await client.messaging.v1.brandRegistrations(row.brandSid!).fetch()
      Object.assign(data, { brandStatus: brand.status, identityStatus: brand.identityStatus ?? null })
      if (brand.status === 'FAILED' || brand.status === 'SUSPENDED' || String(brand.status) === 'EXPIRED') {
        const feedback = (brand.brandFeedback ?? []).map((f) => BRAND_FEEDBACK[f] ?? f)
        meta.failedStep = 'brand'
        meta.rejectedAt = now.toISOString()
        Object.assign(data, { stage: 'failed', note: `The Campaign Registry rejected the brand: ${[errorsText(brand.errors, ''), ...feedback].filter(Boolean).join(' · ') || brand.failureReason || 'no reason given'}` })
      } else if (brand.status === 'APPROVED') {
        if (d.path === 'sole_prop' && brand.identityStatus !== 'VERIFIED') {
          Object.assign(data, { stage: 'otp' })
        } else {
          const campaign = await fileCampaign(client, { ...row, brandStatus: brand.status }, d, meta)
          Object.assign(data, { stage: 'campaign', campaignSid: campaign.sid, campaignStatus: campaign.status })
          console.log(`[hell-level] A2P campaign ${campaign.sid} filed for ${accountId}`)
        }
      } else {
        // Still with the registry; a business profile Twilio turned down won't get further.
        const profile = row.customerProfileSid ? await client.trusthub.v1.customerProfiles(row.customerProfileSid).fetch() : null
        if (profile?.status === 'twilio-rejected') {
          meta.failedStep = 'profile'
          meta.rejectedAt = now.toISOString()
          Object.assign(data, { stage: 'failed', note: `Twilio rejected the business profile: ${errorsText(profile.errors, 'no reason given')}` })
        }
      }
    } else if (row.stage === 'failed') {
      // Resubmitted outside Hell-level: back in review, or through.
      const campaign = await client.messaging.v1.services(row.messagingServiceSid!).usAppToPerson(row.campaignSid!).fetch()
      if (campaign.campaignStatus !== 'FAILED' && campaign.campaignStatus !== 'SUSPENDED') {
        delete meta.failedStep
        delete meta.rejectedAt
        const through = campaign.campaignStatus === 'VERIFIED'
        Object.assign(data, { stage: through ? 'approved' : 'campaign', campaignStatus: campaign.campaignStatus, note: null, ...(through ? { approvedAt: now } : {}) })
        if (through && row.path !== 'sole_prop') await attachNumbers(client, row, meta)
      }
    } else if (row.stage === 'campaign' || row.stage === 'approved') {
      const campaign = await client.messaging.v1.services(row.messagingServiceSid!).usAppToPerson(row.campaignSid!).fetch()
      Object.assign(data, { campaignStatus: campaign.campaignStatus })
      if (campaign.campaignStatus === 'VERIFIED') {
        if (row.stage !== 'approved') Object.assign(data, { stage: 'approved', approvedAt: now, note: null })
        if (row.path !== 'sole_prop') await attachNumbers(client, row, meta)
      } else if (campaign.campaignStatus === 'FAILED' || campaign.campaignStatus === 'SUSPENDED') {
        meta.failedStep = 'campaign'
        meta.rejectedAt = now.toISOString()
        Object.assign(data, { stage: 'failed', note: `Carriers rejected the campaign: ${errorsText(campaign.errors, 'no reason given')}` })
      }
    }
  } catch (err) {
    if (row.stage === 'failed') {
      // Only watching a rejected campaign: its rejection reason stays on show.
    } else if (refused(err)) {
      meta.failedStep = err instanceof StepError ? err.step : row.stage === 'profile' ? 'brand' : 'campaign'
      Object.assign(data, { stage: 'failed', note: problem(err) })
    } else {
      Object.assign(data, { note: `Couldn’t reach Twilio (${problem(err)}); trying again shortly.` })
    }
    console.warn(`[hell-level] A2P step for ${accountId}: ${problem(err)}`)
  }
  row = await prisma.hlA2p.update({ where: { id: row.id }, data: { ...data, meta: asJson(meta), lockedUntil: null } })
  await mirrorNumbers(row)
  return a2pView(accountId)
}

/** Sole proprietor: have the registry text the owner again (the YES text is good for 24 hours). */
export async function resendA2pCode(accountId: string, deps: Deps = {}): Promise<void> {
  const row = await prisma.hlA2p.findUnique({ where: { accountId } })
  if (!row?.brandSid || row.path !== 'sole_prop' || (row.stage !== 'otp' && row.stage !== 'brand')) throw new HlInputError('There’s no text waiting for the owner.')
  const client = deps.client ?? (await twilioClient())
  await client.messaging.v1.brandRegistrations(row.brandSid).brandRegistrationOtps.create()
}

/** After buying a local number: put it on the campaign when there is one, and give it the registration's status. */
export async function syncA2pNumbers(accountId: string, deps: Deps = {}): Promise<void> {
  const row = await prisma.hlA2p.findUnique({ where: { accountId } })
  if (!row) return
  if (row.messagingServiceSid && row.path !== 'sole_prop' && (row.stage === 'campaign' || row.stage === 'approved')) {
    const meta = readMeta(row.meta)
    try {
      await attachNumbers(deps.client ?? (await twilioClient()), row, meta)
      return mirrorNumbers(await prisma.hlA2p.update({ where: { id: row.id }, data: { meta: asJson(meta) } }))
    } catch (err) {
      console.warn(`[hell-level] A2P: couldn’t add the new number for ${accountId}: ${problem(err)}`)
    }
  }
  await mirrorNumbers(row)
}

/** How often each stage is checked. */
const DUE_MS: Partial<Record<A2pStage, number>> = { brand: 5 * 60_000, otp: 5 * 60_000, campaign: 30 * 60_000, approved: 12 * 60 * 60_000 }

/** Every minute: move each registration on when its next check is due. */
let lastSweep = 0
export async function maybeAdvanceA2p(deps: Deps = {}): Promise<number> {
  const now = deps.now ?? new Date()
  if (!deps.now && now.getTime() - lastSweep < 60_000) return 0
  lastSweep = now.getTime()
  const rows = await prisma.hlA2p.findMany({
    where: { OR: [{ stage: { in: [...ACTIVE_STAGES, 'approved'] } }, { stage: 'failed', campaignStatus: 'FAILED', campaignSid: { not: null } }] },
    select: { accountId: true, stage: true, nextAt: true, checkedAt: true },
  })
  let moved = 0
  for (const r of rows) {
    const due = r.stage === 'profile' ? !r.nextAt || r.nextAt <= now : !r.checkedAt || now.getTime() - r.checkedAt.getTime() >= (DUE_MS[r.stage as A2pStage] ?? 30 * 60_000)
    if (!due) continue
    try {
      const v = await advanceA2p(r.accountId, deps)
      if (v && v.stage !== r.stage) moved++
    } catch (err) {
      console.warn(`[hell-level] A2P sweep ${r.accountId}:`, err instanceof Error ? err.message : err)
    }
  }
  return moved
}
