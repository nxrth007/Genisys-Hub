/**
 * The daily read of each linked client's GHL numbers (Phone System → Manage
 * Numbers), pure so it is unit-tested. ./census.ts runs it on the browser
 * worker and ./browser.ts (runGhlCensus) reads the pages. Nothing is changed
 * in GHL.
 *
 * Alex's rule (2026-11-13): a GHL sub-account that already has a number (and
 * its A2P or toll-free setup) is set up and is never asked about one. One with
 * no number needs one at some point, except Forte, whose number is in
 * Hell-level.
 *
 * What the page shows, seen 2026-11-13:
 * - a row per number, e.g. "+1 855-389-5833 Default Number Verification
 *   Required Toll Free Ethan's number 20 s" (columns Numbers, Friendly Name,
 *   Forwarding Number, Call Timeout) or "+1 903-484-1901 Default Number Local …";
 * - "No Data" in the table when the sub-account has none;
 * - "Your phone system requires configuration. Please reach out to our support
 *   team for assistance." when it isn't on LC Phone (Forte's).
 */
import { e164 } from './plan'

/** A number GHL lists for the sub-account. */
export type CensusNumber = { number: string; tollFree: boolean; verificationRequired: boolean; isDefault: boolean }

/** has = at least one number; none = "No Data"; unavailable = no phone system; error = never read successfully. */
export type CensusState = 'has' | 'none' | 'unavailable' | 'error'

/** About once a day per sub-account. */
export const CENSUS_EVERY_MS = 20 * 60 * 60_000
/** A read that failed is tried again after this. */
export const CENSUS_RETRY_MS = 2 * 60 * 60_000
/** Sub-accounts read per browser run. */
export const CENSUS_BATCH = 8

/** One Manage Numbers row's text → its number, or null for a header or any other row. */
export function parseNumberRow(text: string): CensusNumber | null {
  const t = text.replace(/\s+/g, ' ').trim()
  // A price means a row of GHL's buy list, not a number the sub-account has.
  if (/\$\s?\d/.test(t)) return null
  const m = /\+\d[\d\s().-]{6,}\d/.exec(t)
  if (!m) return null
  return {
    number: e164(m[0]) || m[0].replace(/\s+/g, ' '),
    tollFree: /toll\s*free/i.test(t),
    verificationRequired: /verification required/i.test(t),
    isDefault: /default number/i.test(t),
  }
}

/** What a loaded Manage Numbers page says: its numbers, none, no phone system; null while it's still loading. */
export function censusFromPage(pageText: string, rowTexts: string[]): { state: Exclude<CensusState, 'error'>; numbers: CensusNumber[] } | null {
  if (/requires configuration/i.test(pageText) && /support/i.test(pageText)) return { state: 'unavailable', numbers: [] }
  const seen = new Map<string, CensusNumber>()
  for (const r of rowTexts) {
    const n = parseNumberRow(r)
    if (n && !seen.has(n.number)) seen.set(n.number, n)
  }
  if (seen.size) return { state: 'has', numbers: [...seen.values()] }
  if (/Manage Numbers/i.test(pageText) && /No Data/i.test(pageText)) return { state: 'none', numbers: [] }
  return null
}

export type CensusRow = { locationId: string; state: string; checkedAt: Date | null; triedAt: Date }

/**
 * Which linked clients to read next: never read (or linked to a different
 * sub-account since) first, then everything due, oldest try first. A failed
 * read is due again after CENSUS_RETRY_MS, a good one after CENSUS_EVERY_MS.
 */
export function dueForCensus(clients: { id: string; locationId: string; census: CensusRow | null }[], now: number, max = CENSUS_BATCH): string[] {
  const fresh: string[] = []
  const later: { id: string; at: number }[] = []
  for (const c of clients) {
    const r = c.census
    if (!r || r.locationId !== c.locationId) {
      fresh.push(c.id)
      continue
    }
    const failed = !r.checkedAt || r.triedAt.getTime() > r.checkedAt.getTime()
    const at = failed ? r.triedAt.getTime() : r.checkedAt!.getTime()
    if (now - at >= (failed ? CENSUS_RETRY_MS : CENSUS_EVERY_MS)) later.push({ id: c.id, at })
  }
  later.sort((a, b) => a.at - b.at)
  return [...fresh, ...later.map((x) => x.id)].slice(0, Math.max(0, max))
}

/** The read that applies to the client's linked sub-account now; null when there's none yet (or it was another sub-account). */
export function currentCensus<T extends { locationId: string }>(row: T | null | undefined, locationId: string | null | undefined): T | null {
  return row && locationId && row.locationId === locationId ? row : null
}

/** What Echo's number question goes by: has a number, none, no phone system, not read yet; null without a linked sub-account. */
export function askView(row: { locationId: string; state: string } | null | undefined, locationId: string | null | undefined): 'has' | 'none' | 'unavailable' | 'unchecked' | null {
  if (!locationId) return null
  const r = currentCensus(row, locationId)
  return r && (r.state === 'has' || r.state === 'none' || r.state === 'unavailable') ? r.state : 'unchecked'
}

/**
 * Where a client's phone number stands, for Sites: hell_level = a number in
 * Hell-level (Forte's toll-free one); ghl = a number in their GHL sub-account
 * (bought through the Office, or there already); asked = Echo's question or
 * the purchase is under way; needs = GHL shows no number; no_phone_system =
 * GHL says the phone system needs configuration; unchecked = not read yet, or
 * no linked sub-account.
 */
export type PhoneState = 'hell_level' | 'ghl' | 'asked' | 'needs' | 'no_phone_system' | 'unchecked'

const UNDER_WAY = new Set(['awaiting_approval', 'awaiting_identity', 'buying', 'ghl_working'])

export function phoneState(o: { hlNumber: boolean; request: { status: string; route: string } | null; census: string | null }): PhoneState {
  if (o.hlNumber) return 'hell_level'
  if (o.request?.status === 'bought') return o.request.route === 'ghl' ? 'ghl' : 'hell_level'
  if (o.census === 'has') return 'ghl'
  if (o.request && UNDER_WAY.has(o.request.status)) return 'asked'
  if (o.census === 'none') return 'needs'
  if (o.census === 'unavailable') return 'no_phone_system'
  return 'unchecked'
}

/** The numbers saved with a read (JSON from the database), keeping only well-formed ones. */
export function readCensusNumbers(json: unknown): CensusNumber[] {
  if (!Array.isArray(json)) return []
  return json.flatMap((x) => {
    const n = (x ?? {}) as Partial<CensusNumber>
    return typeof n.number === 'string' && n.number
      ? [{ number: n.number, tollFree: n.tollFree === true, verificationRequired: n.verificationRequired === true, isDefault: n.isDefault === true }]
      : []
  })
}
