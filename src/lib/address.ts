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
