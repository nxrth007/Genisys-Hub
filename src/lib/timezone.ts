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
 * Map a state name or 2-letter code directly to an IANA tz. Used by
 * the agent form to resolve a customer tz from the **selected
 * client's** state when the address is still empty — Mary picking
 * "Home Energy Upgrade (California)" before typing the address is
 * already enough info to know the time should be PT.
 *
 * Returns null when the input doesn't match a known state, so callers
 * can decide whether to fall through to the default tz or wait for
 * more information.
 */
export function timezoneForStateName(
  stateInput: string | null | undefined,
): string | null {
  if (!stateInput) return null
  const trimmed = stateInput.trim()
  if (!trimmed) return null
  const lc = trimmed.toLowerCase()
  // Try the spelled-out name first ("California" → "CA").
  const fromName = STATE_NAME_TO_CODE[lc]
  if (fromName && STATE_CODE_TO_TIMEZONE[fromName]) {
    return STATE_CODE_TO_TIMEZONE[fromName]
  }
  // Then the 2-letter code as-typed.
  const upper = trimmed.toUpperCase()
  if (STATE_CODE_TO_TIMEZONE[upper]) return STATE_CODE_TO_TIMEZONE[upper]
  return null
}

/**
 * Best-effort tz resolution: prefer the address (most specific —
 * a CA address tells us exactly where the customer lives), fall
 * back to the client's nominal state (Mary picked the CA client
 * but hasn't typed the address yet), then to America/New_York.
 *
 * Used by the agent appointment form so picking a client is enough
 * to lock the wall-clock interpretation to that client's zone —
 * before this, an empty-address form silently defaulted to NY
 * regardless of which CA/AZ/UT client was selected, and Mary's
 * "6 PM" would store as 6 PM EDT (= 3 PM PDT).
 */
export function resolveCustomerTimezone(params: {
  address?: string | null
  clientState?: string | null
}): string {
  const fromAddress = stateCodeFromAddress(params.address)
  if (fromAddress && STATE_CODE_TO_TIMEZONE[fromAddress]) {
    return STATE_CODE_TO_TIMEZONE[fromAddress]
  }
  const fromClient = timezoneForStateName(params.clientState)
  if (fromClient) return fromClient
  return DEFAULT_TIMEZONE
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

/**
 * Interpret a wall-clock string ("YYYY-MM-DDTHH:mm" or
 * "YYYY-MM-DD HH:mm" or US-style "M/D/YYYY h:mm AM/PM") as if it
 * were typed in the *target* IANA timezone, and return the matching
 * UTC ISO string.
 *
 * This is the timezone-correct way to handle Hub form input: Mary
 * is in the Philippines but her "9 AM" almost always means "9 AM at
 * the customer's location" since she's calling on their behalf
 * during US business hours. JavaScript's default `new Date(local)`
 * interprets the string in the BROWSER's timezone — for Mary that's
 * UTC+8, which silently shifts every appointment by ~16 hours when
 * the customer is in California. Symptom: a "9 AM PT" booking shows
 * up in Slack as "Friday 5 PM previous day" or similar. Using this
 * helper instead pins the wall-clock to the customer's tz and stores
 * the right UTC instant.
 *
 * Strategy: pretend the components are UTC, see what wall-clock that
 * UTC instant displays as in the target tz, the diff is the tz's
 * offset for that moment, subtract to get the real UTC instant.
 * Handles DST transitions correctly because Intl.DateTimeFormat
 * uses the IANA database for offset lookups.
 */
export function wallClockInTzToUtcIso(
  local: string,
  timezone: string,
): string | null {
  if (!local) return null
  // Accept several common forms. ISO-ish first, then US "M/D/YYYY"
  // for sheet cells.
  let Y = 0,
    M = 0,
    D = 0,
    h = 0,
    min = 0
  let parsed = false
  const isoMatch = local.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})/,
  )
  if (isoMatch) {
    Y = parseInt(isoMatch[1], 10)
    M = parseInt(isoMatch[2], 10) - 1
    D = parseInt(isoMatch[3], 10)
    h = parseInt(isoMatch[4], 10)
    min = parseInt(isoMatch[5], 10)
    parsed = true
  } else {
    // US-style "5/12/2026 9:00 AM"
    const usMatch = local.match(
      /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i,
    )
    if (usMatch) {
      M = parseInt(usMatch[1], 10) - 1
      D = parseInt(usMatch[2], 10)
      Y = parseInt(usMatch[3], 10)
      h = parseInt(usMatch[4], 10)
      min = parseInt(usMatch[5], 10)
      const ampm = usMatch[6]?.toUpperCase()
      if (ampm === 'PM' && h < 12) h += 12
      if (ampm === 'AM' && h === 12) h = 0
      parsed = true
    }
  }
  if (!parsed) return null
  if (
    !Number.isFinite(Y) ||
    !Number.isFinite(M) ||
    !Number.isFinite(D) ||
    !Number.isFinite(h) ||
    !Number.isFinite(min)
  ) {
    return null
  }

  const pretendedUtcMs = Date.UTC(Y, M, D, h, min)
  if (!Number.isFinite(pretendedUtcMs)) return null

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const parts = fmt.formatToParts(new Date(pretendedUtcMs))
  const pick = (t: string) =>
    parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10)
  const tzWallMs = Date.UTC(
    pick('year'),
    pick('month') - 1,
    pick('day'),
    pick('hour'),
    pick('minute'),
  )
  const offsetMs = tzWallMs - pretendedUtcMs
  // The actual UTC moment that, when displayed in `timezone`,
  // shows the wall-clock components we started with.
  return new Date(pretendedUtcMs - offsetMs).toISOString()
}
