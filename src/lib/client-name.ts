/**
 * Business-name comparisons that do not need the database.
 * "Snapshot Check LLC" and "TEST Dry Run LLC" stay different even
 * when two forms reuse a placeholder EIN, phone, or website.
 */

const LEGAL_WORDS = /\b(llc|l l c|inc|incorporated|co|corp|corporation|company|ltd|pllc|the|and)\b/g
const TRADE_WORDS =
  /\b(construction|constructions|contracting|contractors?|builders?|building|roofing|roofers?|roof|solar|energy|power|fence|fencing|plumbing|hvac|heating|cooling|air|electric|electrical|remodeling|renovations?|exteriors?|interiors?|home|homes|improvements?|services?|solutions|group|enterprises?|pros?|landscaping|lawn|painting|concrete|windows?|doors?|siding|gutters?|pools?|llc)\b/g

const words = (name: string | null | undefined) =>
  (name ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(LEGAL_WORDS, ' ')

/** "A-Plus Fence & Construction, LLC" → "aplusfenceconstruction". */
export function compactName(name: string | null | undefined): string {
  return words(name).replace(/\s+/g, '')
}

/** The part of the name that isn't the trade: "A Plus Fence & Construction" → "aplus". */
export function coreName(name: string | null | undefined): string {
  return words(name).replace(TRADE_WORDS, ' ').replace(/\s+/g, '')
}

export const SAME_NAME = 'same name, give or take spacing / LLC'
export const SIMILAR_NAME = 'similar name'

/** Both names are present and are not the same business, even ignoring LLC and the trade word. */
export function distinctBusinessNames(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = compactName(a)
  const right = compactName(b)
  if (left.length < 4 || right.length < 4) return false
  if (left === right) return false
  const leftCore = coreName(a)
  const rightCore = coreName(b)
  if (leftCore.length >= 4 && rightCore.length >= 4 && leftCore === rightCore) return false
  return true
}

/**
 * A shared EIN, phone, email, or website does not make two different
 * business names the same client.
 */
export function mayLinkIntake(intakeName: string | null | undefined, clientName: string | null | undefined, why: string[]): boolean {
  if (!why.length) return false
  if (why.length === 1 && why[0] === SIMILAR_NAME) return false
  if (distinctBusinessNames(intakeName, clientName)) return false
  return true
}
