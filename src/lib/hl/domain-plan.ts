/**
 * Forge's domain question for a new client (pure; Porkbun, the database and
 * the Office are in ./domain-request.ts).
 *
 * After onboarding, a client who isn't bringing their own domain gets three
 * available domains to pick from in the Office, priced by Porkbun. The ideas
 * come from the business name (legal endings like LLC dropped), in the order
 * people would type them: the plain name in .com, then .org, then with their
 * city, then small variations. Nothing premium, nothing over $25 a year.
 */

/** A suggestion as the Office shows it: Porkbun's all-in price for the first year, and the renewal. */
export type DomainChoice = { name: string; costCents: number; renewalCents: number | null }

/** What Porkbun's availability check says about one name. */
export type DomainOption = { name: string; available: boolean; priceCents: number | null; renewalCents: number | null; premium: boolean; inYourAccount: boolean }

/** The most a suggestion may cost a year, first year or renewal. */
export const MAX_YEARLY_CENTS = 2500

const LEGAL = /\b(l\.?l\.?c|inc|incorporated|corp|corporation|co|company|ltd|pllc|lp)\b\.?/gi
const VALID = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])\.[a-z]{2,}$/

/** "Acme Roofing & Gutters, LLC" → "acmeroofingandgutters". Notes in brackets and legal endings dropped. */
export function domainSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(LEGAL, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]/g, '')
}

/** The names to check, best first (at most 25: one Porkbun call). */
export function domainCandidates(businessName: string, city?: string | null): string[] {
  const base = domainSlug(businessName)
  if (base.length < 3) return []
  const full = businessName.toLowerCase().replace(/\(.*?\)/g, ' ').replace(/&/g, ' and ').replace(/[^a-z0-9]/g, '')
  const town = (city ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const withTown = town.length >= 3 && !base.includes(town)
  const names = [
    `${base}.com`,
    `${base}.org`,
    ...(withTown ? [`${base}${town}.com`] : []),
    `${base}.net`,
    `get${base}.com`,
    `${base}co.com`,
    ...(withTown ? [`${base}${town}.org`] : []),
    ...(full !== base ? [`${full}.com`] : []),
    `${base}llc.com`,
    `the${base}.com`,
    `${base}.co`,
    `${base}.us`,
    ...(full !== base ? [`${full}.org`] : []),
    `${base}.pro`,
    `${base}.services`,
    `${base}.company`,
  ]
  return [...new Set(names)].filter((n) => VALID.test(n)).slice(0, 25)
}

/** The three to suggest: available, not premium, not already ours, within MAX_YEARLY_CENTS, in candidate order. */
export function pickDomainOptions(candidates: string[], checks: DomainOption[], n = 3): DomainOption[] {
  const byName = new Map(checks.map((c) => [c.name, c]))
  return candidates
    .map((name) => byName.get(name))
    .filter(
      (c): c is DomainOption =>
        !!c && c.available && !c.premium && !c.inYourAccount && c.priceCents !== null && c.priceCents <= MAX_YEARLY_CENTS && (c.renewalCents === null || c.renewalCents <= MAX_YEARLY_CENTS),
    )
    .slice(0, n)
}

export type DomainAskCandidate = {
  archived: boolean
  accountId: string | null
  /** The onboarding form said they're bringing a domain they already have. */
  bringingOwnDomain: boolean
  /** Their Hell-level sub-account already holds a domain. */
  hasDomain: boolean
  /** Their site is already live (Clients: the site we built). */
  siteLive: boolean
  request: { status: string } | null
  trigger: 'onboarding' | 'sweep' | 'manual'
  accountCreatedAt: Date | null
  since: Date
}

/**
 * Forge asks once per new client, right after onboarding made their
 * sub-account. By hand (manual) a person can ask for anyone without a
 * domain on their sub-account, after a None of these or a failure too.
 */
export function domainAskDecision(c: DomainAskCandidate): { ask: boolean; reason: string } {
  if (c.archived) return { ask: false, reason: 'the client is archived' }
  if (!c.accountId) return { ask: false, reason: 'no Hell-level sub-account yet' }
  if (c.hasDomain) return { ask: false, reason: 'its sub-account already has a domain' }
  const r = c.request?.status
  if (r === 'awaiting_approval' || r === 'buying') return { ask: false, reason: 'already asked' }
  if (r === 'bought') return { ask: false, reason: 'it already has its domain' }
  if (c.trigger !== 'manual') {
    if (c.bringingOwnDomain) return { ask: false, reason: 'they’re bringing their own domain (onboarding form)' }
    if (c.siteLive) return { ask: false, reason: 'their site is already live' }
    if (r === 'declined') return { ask: false, reason: 'someone answered None of these' }
    if (r) return { ask: false, reason: 'the last try failed; a person picks it up' }
    if (c.trigger === 'sweep' && (!c.accountCreatedAt || c.accountCreatedAt.getTime() < c.since.getTime())) {
      return { ask: false, reason: 'its sub-account is older than the domain question' }
    }
  }
  return { ask: true, reason: 'no domain yet' }
}

/** The saved suggestions (JSON from the database), keeping only well-formed ones. */
export const readChoices = (v: unknown): DomainChoice[] =>
  Array.isArray(v)
    ? v.flatMap((x) => {
        const c = (x ?? {}) as Partial<DomainChoice>
        return typeof c.name === 'string' && typeof c.costCents === 'number' && c.costCents > 0
          ? [{ name: c.name, costCents: c.costCents, renewalCents: typeof c.renewalCents === 'number' ? c.renewalCents : null }]
          : []
      })
    : []

/** "$11.08/yr" for the Office. */
export const yearly = (cents: number) => `$${(cents / 100).toFixed(2)}/yr`
