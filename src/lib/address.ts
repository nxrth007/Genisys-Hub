/**
 * Address parts + bidirectional helpers between the four-field UI on
 * the booking form and the single-line `address` string the DB +
 * Master Table sheet still store.
 *
 * The DB column is one TEXT field. We keep it that way (no schema
 * migration, no sheet column shuffling) and just translate at the
 * UI boundary: format four parts into "Street, City, ST 12345" on
 * the way out, parse it back into parts on edit-mode prefill.
 */

export type AddressParts = {
  street: string
  city: string
  state: string
  zip: string
}

export const EMPTY_ADDRESS: AddressParts = {
  street: '',
  city: '',
  state: '',
  zip: '',
}

/**
 * State options the dropdown shows. Genisys currently only operates
 * in AZ / CA / UT — the agent picks one of these or "Other" to type
 * a state code manually for an out-of-area booking.
 */
export const PRIMARY_STATES = ['AZ', 'CA', 'UT'] as const
export type PrimaryState = (typeof PRIMARY_STATES)[number]

/** Map of US state name → 2-letter code. Used by the autocomplete to
 *  normalize Nominatim's spelled-out state names ("Arizona") to the
 *  short codes our dropdown speaks. */
export const STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR',
  california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS',
  kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
  ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
  wisconsin: 'WI', wyoming: 'WY',
}

/** Reverse map: 2-letter code → properly-cased full name. Built from
 *  STATE_NAME_TO_CODE so adding a state to one map automatically
 *  populates the other. Used by canonicalizeStateName below. */
export const STATE_CODE_TO_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_NAME_TO_CODE).map(([name, code]) => [
    code,
    name
      .split(' ')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' '),
  ]),
)

/** Normalize a free-text state input (full name or 2-letter code,
 *  any case) to the canonical proper-cased full name (e.g. "nh",
 *  "NH", "new hampshire", "NEW HAMPSHIRE" → "New Hampshire"). Returns
 *  null when the input is empty / whitespace, or the original
 *  trimmed input when it doesn't match a known state — that way a
 *  legitimate territory or typo doesn't get silently dropped. */
export function canonicalizeStateName(
  input: string | null | undefined,
): string | null {
  if (!input) return null
  const trimmed = input.trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  // Full-name match (handles "new hampshire", "New Jersey", etc.).
  if (STATE_NAME_TO_CODE[lower]) {
    return STATE_CODE_TO_NAME[STATE_NAME_TO_CODE[lower]]
  }
  // 2-letter code match (handles "NH", "nj", etc.).
  if (trimmed.length === 2) {
    const upper = trimmed.toUpperCase()
    if (STATE_CODE_TO_NAME[upper]) return STATE_CODE_TO_NAME[upper]
  }
  // Unknown — return as-typed so the data isn't lost.
  return trimmed
}

/** Is this input recognized as a US state / DC? Accepts full name
 *  or 2-letter code, any case. Empty / whitespace counts as
 *  recognized (state is an optional field — the validator decides
 *  separately whether to require it). Used by the create / patch
 *  validators to reject typos like "Newjerey" before they hit the
 *  DB. */
export function isKnownState(input: string | null | undefined): boolean {
  if (!input) return true
  const trimmed = input.trim()
  if (!trimmed) return true
  const lower = trimmed.toLowerCase()
  if (STATE_NAME_TO_CODE[lower]) return true
  if (trimmed.length === 2) {
    const upper = trimmed.toUpperCase()
    if (STATE_CODE_TO_NAME[upper]) return true
  }
  return false
}

/**
 * Combine the four parts into a single string. Empty parts are
 * dropped silently — partial entries still produce a sensible display
 * (e.g. just street + city is "123 Main St, Phoenix" with no comma
 * dangling off the end).
 */
export function formatAddress(parts: AddressParts): string {
  const street = parts.street.trim()
  const city = parts.city.trim()
  const state = parts.state.trim().toUpperCase()
  const zip = parts.zip.trim()
  const tail = [state, zip].filter(Boolean).join(' ')
  return [street, city, tail].filter(Boolean).join(', ')
}

/* -------------------------------------------------------------------------- */
/* Raw-string normalization                                                    */
/*                                                                             */
/* Sheet entries arrive in wildly inconsistent shapes — ALL CAPS, missing     */
/* comma spacing, double whitespace, stripped leading-zero ZIPs. We don't    */
/* mutate the source-of-truth Google Sheet (the call center types directly   */
/* into it; surprise rewrites would be jarring), so the cleanup happens at   */
/* sync time, on the way into the Hub. The Master Tracker API route applies */
/* this once and the rest of the stack just renders the cleaned value.       */
/*                                                                            */
/* normalizeAddress is idempotent — a well-formatted address passes through  */
/* untouched, and re-running never causes drift. Same input → same output.   */
/* -------------------------------------------------------------------------- */

// US state + territory two-letter codes. Tokens matching this set keep
// their uppercase form even when the rest of the address gets
// Title-Cased.
const US_STATE_CODES = new Set(
  ('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS ' +
    'MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV ' +
    'WI WY DC PR VI GU AS MP').split(' ')
)

// Tokens that read better in all-caps than Title-Cased: state codes,
// country codes, cardinal directions, and a few common postal
// abbreviations.
const ADDRESS_KEEP_UPPER = new Set<string>([
  ...US_STATE_CODES,
  'USA', 'US', 'PO',
  'N', 'S', 'E', 'W',
  'NE', 'NW', 'SE', 'SW',
  'NNE', 'NNW', 'SSE', 'SSW', 'ENE', 'ESE', 'WNW', 'WSW',
])

/** Title-case a single word ("MAIN" → "Main", "ST" → "St"). Leaves
 *  non-letter strings and intentionally mixed-case words alone. */
function titleCaseWord(word: string): string {
  if (!word) return word
  if (!/[A-Za-z]/.test(word)) return word
  // Mixed case (e.g. "McDonald", "DeShawn") — don't touch.
  if (word !== word.toUpperCase()) return word
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
}

/**
 * Clean up a raw address string for storage + display. Returns null
 * for null input so the caller can distinguish "no address" from
 * "blank string". Idempotent.
 */
export function normalizeAddress(
  raw: string | null | undefined
): string | null {
  if (raw == null) return null
  let s = String(raw).trim()
  if (!s) return ''
  // Collapse runs of whitespace.
  s = s.replace(/\s+/g, ' ')
  // Normalize comma spacing — strip space before, ensure single space
  // after, drop a stray trailing comma.
  s = s.replace(/\s*,\s*/g, ', ').replace(/,\s*$/, '')

  // Word-by-word case fixup. We only rewrite words that are *entirely*
  // uppercase — anything mixed-case (intentional, like "DeShawn") is
  // preserved as-is.
  const words = s.split(' ').map((token) => {
    // Pull the alphanumeric "core" out, keep surrounding punctuation
    // (commas, periods, parens) intact for the rebuild.
    const match = token.match(
      /^([^A-Za-z0-9]*)([A-Za-z0-9'’\-&/]+)([^A-Za-z0-9]*)$/
    )
    if (!match) return token
    const [, pre, core, post] = match
    // Pure-numeric — house number, ZIP, etc. — leave alone.
    if (/^\d+$/.test(core)) return token
    if (
      ADDRESS_KEEP_UPPER.has(core.toUpperCase()) &&
      core === core.toUpperCase()
    ) {
      return token
    }
    return pre + titleCaseWord(core) + post
  })

  // ZIP padding: when the sheet strips the leading zero from a
  // Northeast ZIP ("03038" → "3038"), pad it back to 5 digits if the
  // preceding token is a US state code. Only fires on the trailing
  // 4-digit token, so it never accidentally pads a house number.
  if (words.length >= 2) {
    const last = words[words.length - 1]
    const prev = words[words.length - 2]
    if (/^\d{4}$/.test(last)) {
      const stateCore = prev.replace(/[^A-Za-z]/g, '').toUpperCase()
      if (US_STATE_CODES.has(stateCore)) {
        words[words.length - 1] = '0' + last
      }
    }
  }

  return words.join(' ')
}

/**
 * Best-effort split of a "Street, City, ST 12345" line back into
 * parts. Used on edit-mode prefill where the DB has a flat string.
 *
 * Heuristic:
 *  - Split on commas. If the last segment looks like "ST 12345"
 *    (or "ST" alone, or "12345" alone), pull state + zip out of it
 *    and treat the segment before it as city.
 *  - Anything earlier joined back together is the street.
 *  - If parsing doesn't find state/zip, dump the whole input into
 *    `street` so the agent can fix it manually rather than losing it.
 */
export function parseAddress(raw: string | null | undefined): AddressParts {
  if (!raw) return { ...EMPTY_ADDRESS }
  const trimmed = raw.trim()
  if (!trimmed) return { ...EMPTY_ADDRESS }

  const segments = trimmed.split(',').map((s) => s.trim()).filter(Boolean)
  if (segments.length === 0) return { ...EMPTY_ADDRESS }

  // Single-segment input — try to peel "ST 12345" off the end; if no
  // match, treat everything as the street.
  const last = segments[segments.length - 1]
  const tailMatch = last.match(/^([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/)
  const stateOnly = last.match(/^([A-Za-z]{2})$/)
  const zipOnly = last.match(/^(\d{5}(?:-\d{4})?)$/)

  let state = ''
  let zip = ''
  let cityIdx = segments.length - 1 // default: city is last segment
  if (tailMatch) {
    state = tailMatch[1].toUpperCase()
    zip = tailMatch[2]
    cityIdx = segments.length - 2
  } else if (stateOnly) {
    state = stateOnly[1].toUpperCase()
    cityIdx = segments.length - 2
  } else if (zipOnly) {
    zip = zipOnly[1]
    cityIdx = segments.length - 2
  }

  const city = cityIdx >= 0 ? segments[cityIdx] : ''
  const street = segments.slice(0, Math.max(cityIdx, 0)).join(', ')

  // If we couldn't recover anything meaningful (no state/zip AND only
  // one segment), the input wasn't really structured — drop it all
  // into street so the agent can just retype.
  if (!state && !zip && segments.length === 1) {
    return { street: segments[0], city: '', state: '', zip: '' }
  }

  return { street, city, state, zip }
}
