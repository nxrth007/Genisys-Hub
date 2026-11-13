import { prisma } from '@/lib/prisma'
import { gbpBoard, searchMapsListings } from '@/lib/gbp-setup'
import { readProfile, setHlReviewLink } from './accounts'
import { pickReviewListing, reviewLinkForPlace, type ListingCandidate } from './review-link-plan'

/**
 * Filling in client sub-accounts' Google review links (Alex, 2026-11-13: all
 * 57 were blank, so the review survey sent happy customers to a Google search
 * instead of the review box). For each sub-account without one: the Google
 * profile board's review link when the profile was marked verified there,
 * else its Google Maps listing when exactly one shares its phone or website
 * (./review-link-plan.ts). A preview first; only the links a person passes
 * back are saved, and never over one already there.
 */

export type ReviewLinkRow = {
  clientId: string
  client: string
  /** The link to save, or null when a person should look. */
  link: string | null
  source: 'board' | 'maps' | null
  why: string
  listing: Pick<ListingCandidate, 'name' | 'address' | 'matches' | 'mapsUrl'> | null
}

async function one(clientId: string, client: string): Promise<ReviewLinkRow> {
  const row: ReviewLinkRow = { clientId, client, link: null, source: null, why: '', listing: null }
  try {
    const board = await gbpBoard(clientId)
    if (!board) return { ...row, why: 'client not found' }
    if (board.state.reviewUrl) return { ...row, link: board.state.reviewUrl, source: 'board', why: 'the Google profile board has it (profile marked verified)' }
    const found = await searchMapsListings({ ...board.prefill, ...board.state.values })
    if (found.error) return { ...row, why: found.error }
    const pick = pickReviewListing(found.candidates, found.query)
    const listing = pick.best ? { name: pick.best.name, address: pick.best.address, matches: pick.best.matches, mapsUrl: pick.best.mapsUrl } : null
    return { ...row, link: pick.placeId ? reviewLinkForPlace(pick.placeId) : null, source: pick.placeId ? 'maps' : null, why: pick.why, listing }
  } catch (err) {
    return { ...row, why: err instanceof Error ? err.message : String(err) }
  }
}

/** What would be filled in, sub-account by sub-account. Read-only; one Maps search per sub-account without a link. */
export async function previewReviewLinks(): Promise<ReviewLinkRow[]> {
  const accounts = await prisma.hlAccount.findMany({
    where: { archivedAt: null, clientId: { not: null }, client: { is: { archivedAt: null } } },
    select: { clientId: true, profile: true, client: { select: { name: true } } },
    orderBy: { name: 'asc' },
  })
  const todo = accounts.filter((a) => a.clientId && !readProfile(a.profile).reviewLink?.trim())
  const rows: ReviewLinkRow[] = []
  // A few at a time, to go easy on Google.
  for (let i = 0; i < todo.length; i += 4) {
    rows.push(...(await Promise.all(todo.slice(i, i + 4).map((a) => one(a.clientId!, a.client?.name ?? '')))))
  }
  return rows
}

/** Save the links a person checked. Only where the sub-account still has none. */
export async function saveReviewLinks(links: { clientId: string; link: string }[]): Promise<{ clientId: string; saved: boolean }[]> {
  const out: { clientId: string; saved: boolean }[] = []
  for (const l of links) out.push({ clientId: l.clientId, saved: await setHlReviewLink(l.clientId, l.link, { onlyIfBlank: true }).catch(() => false) })
  return out
}
