/**
 * Which Google Maps listing a client's Google review link comes from (pure;
 * the search and the saving are in ./review-links.ts).
 *
 * A listing only counts when it shares the business's phone number or
 * website, isn't permanently closed, and is the only one that does. A name
 * alone is never enough: plenty of contractors share a name, and a review
 * on someone else's business is worse than none.
 */

export type ListingCandidate = {
  placeId: string
  name: string
  address: string
  status: string | null
  matches: string[]
  mapsUrl: string | null
}

export type ListingPick = {
  /** The listing to link, or null when a person should choose. */
  placeId: string | null
  /** The closest listing, to show a person either way. */
  best: ListingCandidate | null
  why: string
}

/** Google's "write a review" page for a Maps listing. */
export const reviewLinkForPlace = (placeId: string) => `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`

const strongMatch = (c: ListingCandidate) => c.matches.includes('same phone') || c.matches.includes('same website')

export function pickReviewListing(candidates: ListingCandidate[], query: string): ListingPick {
  const open = candidates.filter((c) => c.placeId && c.status !== 'CLOSED_PERMANENTLY')
  const strong = open.filter(strongMatch)
  const ids = new Set(strong.map((c) => c.placeId))
  const best = strong[0] ?? open[0] ?? null
  if (ids.size === 1) {
    const what = [...new Set(strong.flatMap((c) => c.matches))].filter((m) => m !== 'same name').map((m) => m.replace('same ', ''))
    return { placeId: strong[0].placeId, best: strong[0], why: `its Google Maps listing has the same ${what.join(' and ')}` }
  }
  if (ids.size > 1) return { placeId: null, best, why: 'more than one Google Maps listing has its phone or website; pick one by hand' }
  if (best) return { placeId: null, best, why: `only a name matches on Google Maps (searched “${query}”); check by hand` }
  return { placeId: null, best: null, why: `no Google Maps listing found (searched “${query}”)` }
}
