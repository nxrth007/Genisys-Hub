/**
 * State → IANA timezone derivation. Used by the SMS reminder
 * scheduler to figure out the customer's local time given an address.
 *
 * Each entry is a *primary* timezone for the state — most states sit
 * in a single zone, the few that span two get the dominant one.
 * For the SMS-reminder use case (rough "1 day before" / "30 min
 * before" timing) being off by an hour for the rare cross-zone
 * resident is acceptable; nothing crash-worthy.
 *
 * Genisys's three operating states (AZ / CA / UT) are exact:
 *   - AZ → America/Phoenix (no DST, distinct from MST)
 *   - CA → America/Los_Angeles
 *   - UT → America/Denver
 */

import { STATE_NAME_TO_CODE } from './address'

const STATE_CODE_TO_TIMEZONE: Record<string, string> = {
  AL: 'America/Chicago',
  AK: 'America/Anchorage',
  AZ: 'America/Phoenix', // No DST — important for Brighton bookings.
  AR: 'America/Chicago',
  CA: 'America/Los_Angeles',
  CO: 'America/Denver',
  CT: 'America/New_York',
  DC: 'America/New_York',
  DE: 'America/New_York',
  FL: 'America/New_York', // FL spans two zones; eastern dominates.
  GA: 'America/New_York',
  HI: 'Pacific/Honolulu',
  IA: 'America/Chicago',
  ID: 'America/Boise', // ID spans two zones; Boise (south) dominates.
  IL: 'America/Chicago',
  IN: 'America/Indiana/Indianapolis',
  KS: 'America/Chicago', // KS has 4 western counties on Mountain — minor.
  KY: 'America/New_York', // KY spans two; eastern dominates.
  LA: 'America/Chicago',
  MA: 'America/New_York',
  MD: 'America/New_York',
  ME: 'America/New_York',
  MI: 'America/Detroit', // UP is on Central — minor.
  MN: 'America/Chicago',
  MO: 'America/Chicago',
  MS: 'America/Chicago',
  MT: 'America/Denver',
  NC: 'America/New_York',
  ND: 'America/Chicago', // ND spans two; central dominates.
  NE: 'America/Chicago', // NE has western strip on Mountain.
  NH: 'America/New_York',
  NJ: 'America/New_York',
  NM: 'America/Denver',
  NV: 'America/Los_Angeles', // NV has tiny eastern strip on MT.
  NY: 'America/New_York',
  OH: 'America/New_York',
  OK: 'America/Chicago',
  OR: 'America/Los_Angeles', // OR has tiny eastern strip on MT.
  PA: 'America/New_York',
  RI: 'America/New_York',
  SC: 'America/New_York',
  SD: 'America/Chicago', // SD spans two; eastern dominates.
  TN: 'America/Chicago', // TN spans two; central dominates.
  TX: 'America/Chicago', // TX has El Paso on MT.
  UT: 'America/Denver',
  VA: 'America/New_York',
  VT: 'America/New_York',
  WA: 'America/Los_Angeles',
  WI: 'America/Chicago',
  WV: 'America/New_York',
  WY: 'America/Denver',
}

const DEFAULT_TIMEZONE = 'America/New_York'

/**
 * Pull a 2-letter state code out of a free-form address string.
 * Looks for either a spelled-out state name or a US Postal Service
 * code. Returns null when nothing recognizable is found.
 */
export function stateCodeFromAddress(address: string | null | undefined): string | null {
  if (!address) return null
  const lc = address.toLowerCase()

  // Spelled-out state names — try the longer ones first so e.g.
  // "south carolina" doesn't get partially matched as "carolina".
  const sortedNames = Object.keys(STATE_NAME_TO_CODE).sort(
    (a, b) => b.length - a.length
  )
  for (const name of sortedNames) {
    if (lc.includes(name)) return STATE_NAME_TO_CODE[name]
  }

  // Postal code as a word boundary so "SCALA" doesn't match "CA".
  // The address typically ends with ", ST 12345" or " ST" — anchor
  // matches around whitespace / punctuation / end-of-string.
  const match = address.match(/(?:^|[,\s])([A-Z]{2})(?=[\s,]|$|\s+\d{5})/)
  if (match && match[1] in STATE_CODE_TO_TIMEZONE) return match[1]

  return null
}

/**
 * Resolve an address to an IANA timezone. Falls back to
 * `America/New_York` when the address doesn't carry a recognizable
 * state — better than failing the whole reminder, and the timezone
 * is also surfaced on the reminder row so admins can see what the
 * scheduler decided.
 */
export function timezoneForAddress(address: string | null | undefined): string {
  const code = stateCodeFromAddress(address)
  if (!code) return DEFAULT_TIMEZONE
  return STATE_CODE_TO_TIMEZONE[code] ?? DEFAULT_TIMEZONE
}

/**
 * Format a JS Date in a given IANA timezone using a tolerant pattern
 * helper. Mostly used to render the appointment time inside reminder
 * SMS bodies (e.g. "Tomorrow at 2:00 PM").
 */
export function formatInTimezone(
  date: Date,
  timezone: string,
  options: Intl.DateTimeFormatOptions
): string {
  return new Intl.DateTimeFormat('en-US', { ...options, timeZone: timezone }).format(
    date
  )
}
