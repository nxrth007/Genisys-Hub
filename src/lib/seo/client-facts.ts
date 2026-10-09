import { prisma } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/client'
import { seoAlert } from './slack'
import type { BusinessFacts, FactChange, FactConflict, FactKey, FactSource, FactsMeta } from './types'

/**
 * What the client told us, kept track of.
 *
 * The onboarding form (webhook or sheet → ClientIntake) is the client's own
 * word about their business. The first run reads it once, together with the
 * site, to draft the business facts. This module keeps it working after
 * that:
 *
 *  - Every new submission is folded into the facts once — by plain rules,
 *    not a model: real profile links, cities, services, reasons to choose
 *    them, and a founding year or license number when the client states one.
 *    A field the team edited is never overwritten; a disagreement is kept as
 *    a conflict for a person to settle.
 *  - Each fact remembers whether the client or the team set it (shown on the
 *    Business facts tab), with a short history of changes.
 *  - The client's answers go to research, planning and writing in their own
 *    words, and the facts still missing (Google Business Profile, license,
 *    insurance…) become one checklist — so the engine stops re-asking.
 *
 * Deliberately not taken from the form: the phone (the site shows a call-
 * tracking number that forwards to the client's line), the lead email (for
 * us, not the public), the address (often a home address; service-area
 * businesses must never show one) and the legal name (the brand name on the
 * site is what customers search).
 */

const MAX_CHANGES = 40

export type IntakeAnswers = {
  id: string
  receivedAt: Date
  fullName: string | null
  businessName: string | null
  businessAddress: string | null
  customerPhone: string | null
  cities: string | null
  website: string | null
  aboutBusiness: string | null
  mainServices: string | null
  promotions: string | null
  socialLinks: string | null
  whyChooseYou: string | null
  faqs: string | null
  domainName: string | null
  timeZone: string | null
  hasGoogleProfile: string | null
  googleProfileLink: string | null
  yearStarted: string | null
  licenseInfo: string | null
  reviewLinks: string | null
}

const INTAKE_SELECT = {
  id: true,
  receivedAt: true,
  fullName: true,
  businessName: true,
  businessAddress: true,
  customerPhone: true,
  cities: true,
  website: true,
  aboutBusiness: true,
  mainServices: true,
  promotions: true,
  socialLinks: true,
  whyChooseYou: true,
  faqs: true,
  domainName: true,
  timeZone: true,
  hasGoogleProfile: true,
  googleProfileLink: true,
  yearStarted: true,
  licenseInfo: true,
  reviewLinks: true,
} as const

/** The client's newest onboarding submission. */
export async function latestIntakeFor(clientId: string | null): Promise<IntakeAnswers | null> {
  if (!clientId) return null
  return prisma.clientIntake.findFirst({ where: { clientId }, orderBy: { receivedAt: 'desc' }, select: INTAKE_SELECT })
}

export function emptyMeta(): FactsMeta {
  return { sources: {}, intakeId: null, intakeAt: null, changes: [], conflicts: [] }
}

export function readMeta(v: unknown): FactsMeta {
  const m = (v && typeof v === 'object' ? v : {}) as Partial<FactsMeta>
  return {
    sources: m.sources && typeof m.sources === 'object' ? m.sources : {},
    intakeId: typeof m.intakeId === 'string' ? m.intakeId : null,
    intakeAt: typeof m.intakeAt === 'string' ? m.intakeAt : null,
    changes: Array.isArray(m.changes) ? m.changes : [],
    conflicts: Array.isArray(m.conflicts) ? m.conflicts : [],
  }
}

// ---------------------------------------------------------------------------
// Parsing the form's free text
// ---------------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

const STATE_WORDS = new Set(
  'al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy usa us nevada texas new york california florida arizona colorado'.split(' '),
)

const titleCase = (s: string) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase())

/** "Minden, NV; Gardnerville and Carson City" → ["Minden", "Gardnerville", "Carson City"]. */
export function parseCities(text: string | null): string[] {
  if (!text) return []
  const out: string[] = []
  for (const raw of text.split(/[\n;,|/•]+|\s+(?:and|&)\s+/i)) {
    let t = raw.replace(/^[-*\s]+|[.\s]+$/g, '').replace(/\s+/g, ' ').trim()
    // "Rhome TX" → "Rhome": a trailing state belongs to the city before it.
    const words = t.split(' ')
    if (words.length > 1 && STATE_WORDS.has(words[words.length - 1].toLowerCase())) t = words.slice(0, -1).join(' ')
    if (!t || t.length > 60 || STATE_WORDS.has(t.toLowerCase())) continue
    const cased = /[A-Z]/.test(t) ? t : titleCase(t)
    const city = cased.charAt(0).toUpperCase() + cased.slice(1)
    if (!out.some((c) => norm(c) === norm(city))) out.push(city)
  }
  return out.slice(0, 30)
}

/** A comma, line or bullet separated list ("Interior painting, Exterior painting"). */
export function parseList(text: string | null, max: number): string[] {
  if (!text) return []
  const out: string[] = []
  for (const raw of text.split(/[\n;,|•]+|(?:^|\s)[-*]\s+/)) {
    const v = raw.replace(/^[\d.)\s-]+/, '').replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim()
    if (v.length < 3 || v.length > 60) continue
    const item = v.charAt(0).toUpperCase() + v.slice(1)
    if (!out.some((o) => norm(o) === norm(item))) out.push(item)
  }
  return out.slice(0, max)
}

/** Lines, bullets or sentences — short enough to stand alone as one item. */
export function parseItems(text: string | null, max: number): string[] {
  if (!text) return []
  const pieces = text
    .split(/\n+|•|(?:^|\s)[-*]\s+|;\s*|(?<=[.!?])\s+(?=[A-Z])/)
    .map((x) => x.replace(/^[\d.)\s-]+/, '').replace(/\s+/g, ' ').trim())
    .filter((x) => x.length >= 3 && x.length <= 160)
  const out: string[] = []
  for (const p of pieces) if (!out.some((o) => norm(o) === norm(p))) out.push(p.replace(/[.\s]+$/, ''))
  return out.slice(0, max)
}

const PROFILE_HOSTS: [RegExp, string][] = [
  [/(^|\.)google\.[a-z.]+$|(^|\.)g\.page$|^maps\.app\.goo\.gl$|^goo\.gl$|^g\.co$|^share\.google$|(^|\.)business\.site$/, 'Google Business Profile'],
  [/(^|\.)facebook\.com$|^fb\.com$|^m\.facebook\.com$/, 'Facebook'],
  [/(^|\.)instagram\.com$/, 'Instagram'],
  [/(^|\.)yelp\.[a-z.]+$/, 'Yelp'],
  [/(^|\.)angi\.com$|(^|\.)angieslist\.com$/, 'Angi'],
  [/(^|\.)homeadvisor\.com$/, 'HomeAdvisor'],
  [/(^|\.)bbb\.org$/, 'BBB'],
  [/(^|\.)nextdoor\.com$/, 'Nextdoor'],
  [/(^|\.)houzz\.com$/, 'Houzz'],
  [/(^|\.)thumbtack\.com$/, 'Thumbtack'],
  [/(^|\.)linkedin\.com$/, 'LinkedIn'],
  [/(^|\.)tiktok\.com$/, 'TikTok'],
  [/(^|\.)youtube\.com$|^youtu\.be$/, 'YouTube'],
  [/(^|\.)(x|twitter)\.com$/, 'X'],
  [/(^|\.)porch\.com$/, 'Porch'],
  [/(^|\.)buildzoom\.com$/, 'BuildZoom'],
]

/** A canonical form for comparing profile links: https, lower-case host without www, no query or trailing slash. */
export function profileKey(url: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`)
    const path = u.pathname.replace(/\/+$/, '')
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${path}`
  } catch {
    return null
  }
}

/** Real profile links in free text. Bare homepages ("facebook.com") are placeholders and skipped. */
export function parseProfiles(text: string | null): { label: string; url: string }[] {
  if (!text) return []
  const out: { label: string; url: string }[] = []
  const found = text.match(/(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s,;)<>"'\]]*)?/gi) ?? []
  for (const raw of found) {
    const cleaned = raw.replace(/[.)]+$/, '')
    let u: URL
    try {
      u = new URL(/^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`)
    } catch {
      continue
    }
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    const label = PROFILE_HOSTS.find(([re]) => re.test(host))?.[1]
    if (!label) continue
    const path = u.pathname.replace(/\/+$/, '')
    if (label === 'Google Business Profile') {
      // A Maps place, a share link (maps.app.goo.gl, g.page, g.co/kgs) or a knowledge-panel id — not a plain search.
      const place =
        /^\/maps/.test(path) ||
        /^(maps\.app\.goo\.gl|goo\.gl|g\.page|g\.co|share\.google)$/.test(host) ||
        host.endsWith('business.site') ||
        ['cid', 'kgmid', 'ludocid'].some((k) => u.searchParams.has(k))
      if (!place) continue
    } else if (!path) {
      continue // a bare homepage, not a profile
    }
    const url = `https://${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`
    const key = profileKey(url)
    if (key && !out.some((p) => profileKey(p.url) === key)) out.push({ label, url })
  }
  return out.slice(0, 20)
}

/** "since 1989", "established in 2011", "founded 2015". Not "15 years of experience" — that's the person, not the business. */
export function parseEstablished(text: string): number | null {
  const m = /\b(?:since|established(?: in)?|est\.?|founded(?: in)?|started(?: in)?|in business since|opened(?: in)?)\s+(19[5-9]\d|20[0-2]\d)\b/i.exec(text)
  const y = m ? Number(m[1]) : null
  return y && y <= new Date().getFullYear() ? y : null
}

/** "License #12345", "Lic. No. ABC-123", "NV license 0081234". */
export function parseLicense(text: string): string | null {
  const m = /\b(?:licen[cs]e|lic\.?)\s*(?:no\.?|number|num\.?|#)?\s*[:#]?\s*([A-Z]{0,4}[-\s]?\d[\dA-Z-]{3,})/i.exec(text)
  return m ? `License #${m[1].replace(/\s+/g, '')}` : null
}

function parseInsurance(text: string): string | null {
  const m = /[^.\n]*\b(?:fully insured|insured and bonded|bonded and insured|liability insurance|general liability|workers'? comp)[^.\n]*/i.exec(text)
  return m ? m[0].trim().slice(0, 160) : null
}

// ---------------------------------------------------------------------------
// Folding a submission into the facts
// ---------------------------------------------------------------------------

type Applied = { facts: BusinessFacts; meta: FactsMeta; changes: FactChange[]; conflicts: FactConflict[] }

/**
 * Fold one submission into the facts. Pure: returns the new facts and meta.
 * Lists only grow (each submission is applied once, so an entry the team
 * removed stays removed until the client sends it again). Single values fill
 * a gap; a different value never replaces a team edit — it becomes a
 * conflict. A value read automatically from the site gives way to the
 * client's word, except where the parse is a guess (founding year).
 */
export function applyIntake(facts: BusinessFacts, metaIn: FactsMeta, intake: IntakeAnswers, now = new Date()): Applied {
  const at = now.toISOString()
  const meta: FactsMeta = { ...metaIn, sources: { ...metaIn.sources }, conflicts: [...metaIn.conflicts] }
  const next: BusinessFacts = { ...facts }
  const changes: FactChange[] = []
  const conflicts: FactConflict[] = []
  const byTeam = (k: FactKey) => meta.sources[k]?.source === 'team'
  const mark = (k: FactKey, summary: string) => {
    meta.sources[k] = { source: 'client', at, by: null }
    changes.push({ at, field: k, source: 'client', by: null, summary })
  }
  const conflict = (k: FactKey, client: string, current: string) => {
    if (meta.conflicts.some((c) => c.field === k && c.client === client)) return
    const c = { field: k, client, current, at }
    conflicts.push(c)
    meta.conflicts.push(c)
  }

  // Lists: add what's new.
  const cities = parseCities(intake.cities)
  const newCities = cities.filter((c) => !next.serviceAreas.some((s) => norm(s) === norm(c)))
  if (newCities.length) {
    next.serviceAreas = [...next.serviceAreas, ...newCities]
    mark('serviceAreas', `Added ${newCities.join(', ')} from the onboarding form`)
  }

  const profiles = parseProfiles([intake.googleProfileLink, intake.reviewLinks, intake.socialLinks, intake.aboutBusiness].filter(Boolean).join('\n'))
  const newProfiles = profiles.filter((p) => !next.profiles.some((x) => profileKey(x.url) === profileKey(p.url)))
  // A placeholder (bare facebook.com) already in the facts is replaced by the real link of the same kind.
  const kept = next.profiles.filter((x) => {
    const key = profileKey(x.url) ?? ''
    const placeholder = !key.includes('/') && newProfiles.some((p) => p.label === x.label)
    return !placeholder
  })
  if (newProfiles.length) {
    next.profiles = [...kept, ...newProfiles]
    mark('profiles', `Added ${newProfiles.map((p) => p.label).join(', ')} from the onboarding form`)
  }

  const services = parseList(intake.mainServices, 15)
  const newServices = services.filter(
    (s) => !next.services.some((x) => norm(x.name) === norm(s) || norm(x.name).includes(norm(s)) || norm(s).includes(norm(x.name))),
  )
  if (newServices.length) {
    next.services = [...next.services, ...newServices.map((name) => ({ name, slug: null, notes: 'Listed by the client on the onboarding form' }))]
    mark('services', `Added ${newServices.join(', ')} from the onboarding form`)
  }

  const reasons = parseItems(intake.whyChooseYou, 8)
  const newReasons = reasons.filter((r) => !next.differentiators.some((d) => norm(d) === norm(r)))
  if (newReasons.length) {
    next.differentiators = [...next.differentiators, ...newReasons].slice(0, 12)
    mark('differentiators', `Added ${newReasons.length} reason${newReasons.length === 1 ? '' : 's'} to choose them from the onboarding form`)
  }

  // Single values.
  const text = [intake.aboutBusiness, intake.whyChooseYou, intake.faqs, intake.promotions].filter(Boolean).join('\n')

  if (intake.fullName && !next.owner) {
    next.owner = intake.fullName
    mark('owner', `Owner set to ${intake.fullName} (who filled in the onboarding form)`)
  }

  // The form now asks outright; an explicit answer beats what was read off the site.
  const stated = /\b(1[89]\d\d|20\d\d)\b/.exec(intake.yearStarted ?? '')
  const statedYear = stated && Number(stated[1]) <= now.getFullYear() ? Number(stated[1]) : null
  if (statedYear && next.established !== statedYear) {
    if (byTeam('established')) conflict('established', String(statedYear), String(next.established ?? '—'))
    else {
      next.established = statedYear
      mark('established', `Established ${statedYear}, from the onboarding form`)
    }
  }
  const statedLicense = (intake.licenseInfo ?? '').trim()
  if (statedLicense && !/^(not required|none|n\/?a|no)\b/i.test(statedLicense) && next.license !== statedLicense) {
    if (byTeam('license')) conflict('license', statedLicense.slice(0, 160), next.license ?? '—')
    else {
      next.license = statedLicense.slice(0, 160)
      mark('license', `License: ${statedLicense.slice(0, 80)}, from the onboarding form`)
    }
  }

  const year = statedYear ? null : parseEstablished(text)
  if (year && next.established !== year) {
    if (next.established == null) {
      next.established = year
      mark('established', `Established ${year}, from the onboarding form`)
    } else {
      // The parse is a guess and the site's number may be right — a person decides.
      conflict('established', String(year), String(next.established))
    }
  }

  const license = statedLicense ? null : parseLicense(text)
  if (license && next.license !== license) {
    if (!next.license || (!byTeam('license') && !/\d/.test(next.license))) {
      next.license = license
      mark('license', `${license}, from the onboarding form`)
    } else if (!next.license.includes(license.replace('License #', ''))) {
      conflict('license', license, next.license)
    }
  }

  const insurance = parseInsurance(text)
  if (insurance && !next.insurance) {
    next.insurance = insurance
    mark('insurance', 'Insurance, from the onboarding form')
  }

  meta.intakeId = intake.id
  meta.intakeAt = intake.receivedAt.toISOString()
  meta.changes = [...changes.slice().reverse(), ...meta.changes].slice(0, MAX_CHANGES)
  return { facts: next, meta, changes, conflicts }
}

/** Record which fields a person changed when saving the facts form. */
export function markTeamEdits(prev: BusinessFacts | null, next: BusinessFacts, metaIn: FactsMeta, by: string | null, now = new Date()): FactsMeta {
  const at = now.toISOString()
  const meta: FactsMeta = { ...metaIn, sources: { ...metaIn.sources } }
  const changes: FactChange[] = []
  for (const k of Object.keys(next) as FactKey[]) {
    if (prev && JSON.stringify(prev[k]) === JSON.stringify(next[k])) continue
    meta.sources[k] = { source: 'team', at, by }
    changes.push({ at, field: k, source: 'team', by, summary: 'Edited in the Hub' })
  }
  // A field the team just settled has no open conflict any more.
  const touched = new Set(changes.map((c) => c.field))
  meta.conflicts = meta.conflicts.filter((c) => !touched.has(c.field))
  meta.changes = [...changes, ...meta.changes].slice(0, MAX_CHANGES)
  return meta
}

/**
 * Fold the client's newest submission into a site's facts if it hasn't
 * been yet (or again, with `force`). Returns what changed. Never throws
 * for a site without facts or a client — there's simply nothing to do.
 */
export async function syncClientFacts(siteId: string, opts: { force?: boolean; announce?: boolean } = {}): Promise<FactChange[]> {
  const site = await prisma.seoSite.findUnique({
    where: { id: siteId },
    select: { id: true, name: true, clientId: true, facts: true, factsMeta: true, updatedAt: true },
  })
  if (!site?.facts || !site.clientId) return []
  const intake = await latestIntakeFor(site.clientId)
  if (!intake) return []
  const meta = readMeta(site.factsMeta)
  if (!opts.force && meta.intakeId === intake.id) return []

  const applied = applyIntake(site.facts as unknown as BusinessFacts, meta, intake)
  // Only write if the facts are still the ones read above — a save from the form wins.
  const res = await prisma.seoSite.updateMany({
    where: { id: site.id, updatedAt: site.updatedAt },
    data: { facts: applied.facts as unknown as Prisma.InputJsonValue, factsMeta: applied.meta as unknown as Prisma.InputJsonValue },
  })
  if (!res.count) return []
  if (opts.announce && (applied.changes.length || applied.conflicts.length)) {
    const base = (process.env.AUTH_URL || 'http://localhost:3000').replace(/\/+$/, '')
    const lines = [
      ...applied.changes.map((c) => `• ${c.summary}`),
      ...applied.conflicts.map((c) => `• ${FACT_LABELS[c.field]}: the form says "${c.client}", the facts say "${c.current}" — settle it on the Business facts tab`),
    ]
    await seoAlert(`:clipboard: *SEO* — ${site.name}: new onboarding answers folded into the business facts.\n${lines.join('\n')}\n${base}/seo/${site.id}`)
  }
  return applied.changes
}

/** Pick up submissions that arrived since each site's facts were last synced. Cheap; runs on the engine tick. */
export async function syncAllClientFacts(): Promise<void> {
  try {
    const sites = await prisma.seoSite.findMany({
      where: { archivedAt: null, clientId: { not: null } },
      select: { id: true, clientId: true, facts: true, factsMeta: true },
    })
    for (const s of sites) {
      if (!s.facts) continue
      const latest = await prisma.clientIntake.findFirst({ where: { clientId: s.clientId }, orderBy: { receivedAt: 'desc' }, select: { id: true } })
      if (!latest || readMeta(s.factsMeta).intakeId === latest.id) continue
      // The first sync of an existing site is a catch-up, not news.
      await syncClientFacts(s.id, { announce: readMeta(s.factsMeta).intakeId !== null })
    }
  } catch (err) {
    console.error('[seo] client facts sync failed:', err)
  }
}

// ---------------------------------------------------------------------------
// What's still missing, and the client's words for the engine
// ---------------------------------------------------------------------------

export const FACT_LABELS: Record<FactKey, string> = {
  businessName: 'Business name',
  trade: 'Trade',
  schemaType: 'Schema type',
  primaryCity: 'Primary city',
  state: 'State',
  serviceAreas: 'Service areas',
  services: 'Services',
  phone: 'Phone',
  email: 'Email',
  address: 'Address',
  hiddenAddress: 'Service-area business',
  owner: 'Owner',
  established: 'Established',
  license: 'License',
  insurance: 'Insurance',
  warranty: 'Warranty',
  hours: 'Hours',
  pricingNotes: 'Pricing notes',
  differentiators: 'Differentiators',
  projects: 'Projects',
  profiles: 'Profiles',
  brandVoice: 'Brand voice',
  avoid: 'Never say',
  notes: 'Notes',
}

export type FactGap = { key: string; label: string; why: string; ask: string }

const hasProfile = (f: BusinessFacts, labels: string[]) =>
  f.profiles.some((p) => labels.includes(p.label) || labels.some((l) => (profileKey(p.url) ?? '').includes(l.toLowerCase().replace(/\s+/g, ''))))

/** The facts that most help a contractor show up in Google and AI answers, and that we don't have yet. */
export function factGaps(f: BusinessFacts | null, intake?: Pick<IntakeAnswers, 'hasGoogleProfile'> | null): FactGap[] {
  if (!f) return []
  const gaps: FactGap[] = []
  const googleProfile = f.profiles.some((p) => p.label === 'Google Business Profile' || /google\.|g\.page|goo\.gl|share\.google|business\.site/.test(p.url))
  if (!googleProfile && /^no$/i.test(intake?.hasGoogleProfile ?? '')) {
    gaps.push({ key: 'gbp', label: 'Google Business Profile — they don’t have one', why: 'The client said so on the form. Setting one up is the biggest local win available; it needs their verification (postcard, call or video).', ask: 'We’d like to set up your Google Business Profile — can you do a quick call so we can verify it together?' })
  } else if (!googleProfile) {
    gaps.push({ key: 'gbp', label: 'Google Business Profile link', why: 'The single biggest local-ranking factor; also where Google and AI assistants read reviews and hours.', ask: 'The link to your Google Business Profile (search your business on Google Maps → Share → Copy link). If you don’t have one, tell us and we’ll help set it up.' })
  }
  if (!hasProfile(f, ['Yelp', 'Angi', 'HomeAdvisor', 'BBB', 'Thumbtack', 'Houzz', 'Nextdoor', 'Porch'])) {
    gaps.push({ key: 'reviews', label: 'Review-site profiles (Yelp, Angi, BBB…)', why: 'ChatGPT and other assistants build "best contractor near me" answers largely from these.', ask: 'Links to any review profiles you have — Yelp, Angi/HomeAdvisor, BBB, Thumbtack, Houzz or Nextdoor.' })
  }
  if (!hasProfile(f, ['Facebook', 'Instagram', 'TikTok', 'YouTube', 'LinkedIn'])) {
    gaps.push({ key: 'social', label: 'Real social profile links', why: 'The site currently links to a placeholder; real profiles confirm who the business is.', ask: 'Your Facebook / Instagram page links (the full link to your page, not just facebook.com).' })
  }
  if (!f.license) gaps.push({ key: 'license', label: 'License number', why: 'Homeowners and AI answers check licensing; we can only state it if you give it to us.', ask: 'Your contractor license number(s) and the state or county that issued them.' })
  if (!f.insurance) gaps.push({ key: 'insurance', label: 'Insurance', why: '"Licensed and insured" is a top trust signal in contractor searches.', ask: 'Whether you carry general liability insurance (and workers’ comp, if you have it).' })
  if (!f.established) gaps.push({ key: 'established', label: 'Year founded', why: 'A clear founding year beats vague "years of experience" claims and keeps every listing consistent.', ask: 'The year the business started.' })
  if (f.projects.length < 2) gaps.push({ key: 'projects', label: 'Two or three real past jobs', why: 'First-hand project detail is what makes posts credible instead of generic.', ask: 'Two or three recent jobs: what you did, roughly where (town), materials or size, and anything the customer said.' })
  if (!f.pricingNotes) gaps.push({ key: 'pricing', label: 'Typical price ranges', why: 'Cost questions are the most-searched; we never publish prices you haven’t given us.', ask: 'Rough price ranges for your most common jobs (e.g. "a 400 sq ft patio usually runs $X–$Y").' })
  if (!f.hours) gaps.push({ key: 'hours', label: 'Business hours', why: 'Needed for the Google profile and the site’s business details to match.', ask: 'Your business hours.' })
  if (!f.warranty) gaps.push({ key: 'warranty', label: 'Warranty', why: 'A stated warranty is a common deciding factor and quotable in answers.', ask: 'Any warranty you give on your work.' })
  return gaps
}

/** A message the team can paste into a text or email to the client. */
export function clientRequestMessage(f: BusinessFacts | null, gaps: FactGap[], businessName: string): string {
  if (!gaps.length) return ''
  const first = f?.owner?.split(/\s+/)[0]
  return [
    `Hi ${first || 'there'}, quick one from Genisys — to help ${businessName} show up higher on Google and in AI answers (ChatGPT, Google's AI results), could you send us:`,
    ...gaps.map((g, i) => `${i + 1}. ${g.ask}`),
    'Whatever you have is great — reply here whenever you get a chance. Thanks!',
  ].join('\n')
}

const ANSWER_LABELS: [keyof IntakeAnswers, string][] = [
  ['googleProfileLink', 'Google Business Profile link'],
  ['hasGoogleProfile', 'Has a Google Business Profile'],
  ['yearStarted', 'Year the business started'],
  ['licenseInfo', 'License'],
  ['reviewLinks', 'Review sites they are on'],
  ['aboutBusiness', 'About the business'],
  ['mainServices', 'Main services they want promoted'],
  ['cities', 'Cities they serve'],
  ['whyChooseYou', 'Why customers should choose them'],
  ['promotions', 'Current promotions / offers'],
  ['faqs', 'FAQs and their answers'],
  ['socialLinks', 'Social / online profile links'],
]

/** The client's form answers, verbatim, for research, planning and writing. */
export function clientWords(intake: IntakeAnswers | null, gaps: FactGap[]): string {
  const lines: string[] = []
  if (intake) {
    lines.push(
      `## What the client told us (onboarding form, ${intake.receivedAt.toISOString().slice(0, 10)})`,
      'The client’s own words. For facts about the business they outrank the site copy; where the two disagree, say so as an identity problem to fix. Offer promotions only with the terms and dates stated here, and only while they apply.',
    )
    for (const [k, label] of ANSWER_LABELS) {
      const v = intake[k]
      if (typeof v === 'string' && v.trim()) lines.push(`### ${label}`, v.trim().slice(0, 4000))
    }
  }
  if (gaps.length) {
    lines.push(
      '',
      '## Facts still missing (already on the team’s list to ask the client)',
      'Don’t report these as new findings or invent them. Mention one under client questions only if this week’s plan depends on it.',
      ...gaps.map((g) => `- ${g.label}`),
    )
  }
  return lines.join('\n')
}

export type { FactSource }
