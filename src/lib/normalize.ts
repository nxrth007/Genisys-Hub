/**
 * Tiny normalizers for free-text fields agents type into the booking
 * form. The goal is to produce a consistent display string for the
 * Master Table sheet (so client deliverables read uniformly) without
 * being so aggressive we drop useful detail the agent entered.
 *
 * Server-side only — applied in the appointment POST/PATCH endpoints
 * before persisting. The sheet writer pulls from the DB, so once a
 * row is normalized it stays normalized through every sync.
 */

/**
 * Roof age — agents tend to type just a number ("5"), a range
 * ("5-10"), or a "+" suffix ("10+"). Append "years" when the input
 * is a recognizable numeric form and the agent didn't already write
 * it. Leaves prose ("new construction", "unknown") untouched.
 *
 * Returns null for empty input so the column reads "—" in the UI.
 */
export function normalizeRoofAge(raw: unknown): string | null {
  if (raw == null) return null
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  // If the agent already wrote "year(s)" or "yr(s)", normalize the unit
  // to "year(s)" but otherwise leave their phrasing alone. Compresses
  // accidental double spaces too.
  if (/\b(years?|yrs?)\b/i.test(trimmed)) {
    return trimmed
      .replace(/\byrs?\b/gi, (m) => (m.length === 2 ? 'years' : 'year'))
      .replace(/\s+/g, ' ')
  }

  // Pure number — "5", "12", "5.5". Pluralize so "1" reads as "1 year".
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const n = parseFloat(trimmed)
    return `${trimmed} ${n === 1 ? 'year' : 'years'}`
  }

  // Range — "5-10", "5 to 10", "5 – 10" (en-dash). Normalize the
  // separator to a plain hyphen, then append "years".
  const rangeMatch = trimmed.match(/^(\d+)\s*(?:-|–|to)\s*(\d+)$/i)
  if (rangeMatch) {
    return `${rangeMatch[1]}-${rangeMatch[2]} years`
  }

  // Open-ended — "5+", "10 +", "20+ ".
  const plusMatch = trimmed.match(/^(\d+)\s*\+$/)
  if (plusMatch) {
    return `${plusMatch[1]}+ years`
  }

  // Doesn't look like a numeric age — leave the agent's phrasing alone.
  // (e.g. "new construction", "not sure", "original to house")
  return trimmed
}
