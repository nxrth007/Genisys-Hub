import { z } from 'zod'
import { ClaudeSession, FatalClaudeError } from '@/lib/seo/claude'
import type { SiteFacts, SiteFill } from './site-plan'

/**
 * Claude reads a new client's onboarding answers and photos and writes the
 * parts of Ethan's one-shot that need judgment (./site-template.ts): the
 * cleaned-up About, the services, the hero, FAQs, blog topics, what each
 * photo shows and which uploads aren't photos at all. Names, phone, email,
 * links, the embeds and the legal pages are copied in by the Hub, never
 * retyped by Claude. One call per build, after a person's Yes in the Office.
 */

const MODEL = 'claude-opus-5-5'
/** A hard ceiling per fill (a normal one with 20 photos is well under a dollar). */
const BUDGET_USD = 4
/** Claude reads an image up to 5 MB; bigger ones are listed for Lovable without being looked at. */
const MAX_IMAGE_BYTES = 4_800_000

/** Tests swap the call for a stub instead of calling Claude. */
export const fillHooks: { fill: ((facts: SiteFacts) => Promise<FillResult>) | null } = { fill: null }

export type FillResult = {
  fill: SiteFill
  /** Which of facts.photos Claude looked at (0-based, in the order shown: "Photo 1" in fill.photos is facts.photos[shown[0]]). */
  shown: number[]
  costUsd: number
  /** Why the photos weren't looked at, when they weren't. */
  note: string | null
}

const text = z.string()
const SiteFillSchema = z.object({
  legalName: text.describe('The legal business name as supplied, with proper capitals and suffix (LLC, Inc.). Same words: add or drop nothing.'),
  displayName: text.describe('Short brand name for the header and marketing, usually the legal name without LLC/Inc.'),
  cityState: text.describe('Home base as "City, ST", e.g. "Tampa, FL".'),
  fullAddress: text.describe('Full street address for the legal pages only, cleaned up. Empty when incomplete, a PO box or an apartment.'),
  serviceAreaSummary: text.describe('One line, e.g. "Tampa Bay and surrounding communities".'),
  serviceAreaList: z.array(text).describe('Each city or county exactly as supplied (obvious typos fixed), with its state, one per item.'),
  timeZone: text.describe('Eastern, Central, Mountain or Pacific (Alaska/Hawaii when so), checked against the location.'),
  yearStarted: text.describe('Four-digit year the business started, only if supplied. Otherwise empty.'),
  experienceLine: text.describe('e.g. "Over 20 years of experience", only if the owner gave years of experience. Otherwise empty.'),
  licenseLine: text.describe('License or registration exactly as supplied, e.g. "WA Contractor Reg. #ABC*123XY". Empty for none/no/N/A, and never an EIN.'),
  about: text.describe("The owner's About answer, cleaned up (spelling, grammar), 2-4 sentences, no added claims."),
  whyChooseUs: z.array(text).describe("The owner's reasons customers choose them, cleaned up, one per item. Without an answer: plain facts they supplied (services, area, experience), no superlatives."),
  promo: text.describe('A discount or special offer the owner mentioned in any answer (e.g. "5% military discount"), worded as they did; several joined with "; ". Empty when none.'),
  extraFacts: z
    .array(text)
    .describe('Other concrete things the owner offers that no other field holds and that are not discounts (free estimates, financing available, emergency service, a guarantee as stated), short and exact. Empty list when none.'),
  brandColors: text.describe("The client's colors as supplied (cleaned), or empty when none."),
  colorDirection: text.describe('One or two sentences on building the palette: from their colors, or a trade-appropriate palette when none.'),
  trade: text.describe('The trade in a few words, e.g. "roofing", "junk removal", "kitchen and bath remodeling".'),
  regionContext: text.describe('Local climate and housing context for blog posts, e.g. "Florida humidity, hurricane season".'),
  heroHeadline: text.describe('Hero headline: the main service and the area.'),
  heroCopy: text.describe('One or two sentences under the headline, from supplied facts only.'),
  heroImage: text.describe('When one of their photos suits the hero, name it by what it shows ("their photo of a finished paver patio") so the builder finds it in the photo list. Else a realistic photo-style scene for their trade and region, no faces.'),
  primaryCta: text.describe('e.g. "Request an Estimate"; "Get a Free Estimate" only when they offer free estimates.'),
  services: z
    .array(z.object({ name: text, note: text.describe('A few words of detail the owner gave, or empty.') }))
    .describe('Their services, main ones first, 3 to 8. When they named only one or two broad services, the usual parts of those same services, never another trade.'),
  photos: z
    .array(
      z.object({
        photo: z.number().describe('The photo number as labeled.'),
        keep: z.boolean().describe('False for logos, documents, letters (EIN/IRS), ID cards, and screenshots of text, messages or apps.'),
        shows: text.describe('What the photo actually shows, in a few plain words, e.g. "a finished paver patio behind a brick house".'),
        useFor: text.describe('The service or section it fits best (a service name, "gallery" or "hero"), or empty when not kept.'),
      }),
    )
    .describe('One entry per photo shown, in order.'),
  aiImageScenes: text.describe('Distinct realistic photo scenes for sections without a matching client photo, one per service or section, no faces, separated by semicolons.'),
  mapInstructions: text.describe('Where to center the map and how far to zoom to cover the service area.'),
  faqs: z
    .array(z.object({ question: text, answer: text }))
    .describe("The owner's FAQs as written (cleaned up). Without any: 5-7 general FAQs answered only from supplied facts."),
  blogTopics: z.array(text).describe('Exactly 9 local, trade-relevant blog topics for homeowners in their area.'),
  tradeClaimRules: z
    .array(text)
    .describe('Claim bans for this trade, e.g. pest control: no "safe" or "non-toxic"; water treatment: no health or contaminant claims; cleaning: no eco or germ-kill claims. Empty when none apply.'),
  notes: z.array(text).describe('Anything a person should check before this goes out (a PO box address, a blank services answer, answers that look swapped). Empty list when nothing.'),
}) satisfies z.ZodType<SiteFill>

const SYSTEM = `You fill in a website brief for Genisys, which builds websites for small home-service contractors. The web builder (Lovable) copies a template site and swaps in the client's details from the brief. You write the parts that need judgment. The Hub copies the business name, owner, phone, email, links, form and legal pages in itself.

Rules:
- Use ONLY information the client supplied. Never invent licenses, insurance, bonding, certifications, reviews, ratings, years in business, prices, warranties, guarantees, financing terms, awards, project counts or service areas.
- An empty answer, or a non-answer like "no", "none", "N/A", "idk" or "no answer", means not supplied: leave that field empty, or follow the field's own fallback.
- Fix obvious typos in city names and services. Keep names, emails, phone numbers and license text exactly as entered.
- Free estimates, financing, warranties, same-day or emergency service appear only when the client said so.
- Answers sometimes sit in the wrong box (an address as the business name, a phone number as the email). Use each fact where it belongs, and say so in notes.
- Photos: you see the client's uploads, numbered. Keep real photos of their work, jobs, crew, vehicles and equipment. Leave out logos, documents, letters (EIN/IRS), ID cards, and screenshots of text, messages or apps. Describe only what a photo actually shows; never guess a customer, city or project.
- Write plainly for homeowners: no hype, no "best in town", no exclamation marks.`

function factsText(f: SiteFacts): string {
  const line = (label: string, v: string | null | undefined) => `${label}: ${(v ?? '').trim() || '(not supplied)'}`
  return [
    'The client’s onboarding answers, as they typed them:',
    line('Legal business name', f.legalName),
    line('Business name the Hub uses', f.businessName),
    line('Owner', f.ownerName),
    line('Business address', f.address),
    line('Cities or areas served', f.cities),
    line('Time zone answer', f.timeZoneAnswer),
    line('Time zone the Hub works out from the address', f.timeZoneHint),
    line('Current website', f.currentWebsite),
    line('About the business', f.about),
    line('Main services', f.mainServices),
    line('Why customers choose them', f.whyChooseYou),
    line('Promotions', f.promotions),
    line('Brand colors', f.brandColors),
    line('FAQs', f.faqs),
    line('Year started', f.yearStarted),
    line('License info', f.licenseInfo),
    line('Domain the site goes on', f.domain ?? 'none yet'),
    `Phone and email are on file (the Hub adds them).`,
  ].join('\n')
}

/** The photo's size from its first byte (a ranged GET; nothing else is downloaded). Null when the server won't say. */
async function photoBytes(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, cache: 'no-store', signal: AbortSignal.timeout(10_000) })
    const range = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '')
    const length = Number(res.headers.get('content-length'))
    await res.body?.cancel().catch(() => undefined)
    if (!res.ok) return null
    if (range) return Number(range[1])
    return res.status === 200 && Number.isFinite(length) && length > 0 ? length : null
  } catch {
    return null
  }
}

/** Fill the one-shot's judgment fields. Throws (Claude declined, ran out, or isn't reachable) without a partial answer. */
export async function fillOneShot(facts: SiteFacts): Promise<FillResult> {
  if (fillHooks.fill) return fillHooks.fill(facts)
  // Only photos Claude can read go in; the others are still listed for Lovable.
  const sizes = await Promise.all(facts.photos.map((p) => photoBytes(p.url)))
  const shown = facts.photos.map((_, i) => i).filter((i) => (sizes[i] ?? Infinity) <= MAX_IMAGE_BYTES)
  const session = await ClaudeSession.open({ model: MODEL, budgetUsd: BUDGET_USD })
  const ask = (withPhotos: boolean) =>
    session.structured({
      label: 'site one-shot',
      system: SYSTEM,
      context: factsText(facts),
      images: withPhotos ? shown.map((i, n) => ({ label: `Photo ${n + 1} (${facts.photos[i].name}):`, url: facts.photos[i].url })) : [],
      task: withPhotos && shown.length
        ? `Fill the brief from these answers. There are ${shown.length} photos above: give one photos entry for each, numbered as labeled.`
        : 'Fill the brief from these answers. No photos are shown: return an empty photos list.',
      schema: SiteFillSchema,
      effort: 'high',
      maxTokens: 32_000,
    })
  try {
    const fill = await ask(shown.length > 0)
    return { fill, shown, costUsd: session.spentUsd, note: shown.length < facts.photos.length ? `${facts.photos.length - shown.length} photo(s) too big for Claude to look at were passed on as they are.` : null }
  } catch (err) {
    // A photo Claude couldn't fetch or read fails the whole request: try once without them.
    if (!(err instanceof FatalClaudeError) || !shown.length || /spend limit|budget|401|403/i.test(err.message)) throw err
    const fill = await ask(false)
    return { fill, shown: [], costUsd: session.spentUsd, note: `Claude couldn’t look at the photos (${err.message.slice(0, 160)}), so they go to Lovable unchecked.` }
  }
}
