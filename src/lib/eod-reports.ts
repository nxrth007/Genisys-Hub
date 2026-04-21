/**
 * Shared constants for the EOD report module. Kept in lib/ so the agent
 * form, staff review page, and API validator all agree on the same
 * canonical set of technical-issue tags.
 */

export const TECHNICAL_ISSUE_TAGS = [
  { value: 'dialer', label: 'Dialer / phone system' },
  { value: 'crm', label: 'CRM (GHL)' },
  { value: 'hub', label: 'Genisys Hub' },
  { value: 'call_recording', label: 'Call recording' },
  { value: 'connectivity', label: 'Internet / connectivity' },
  { value: 'lead_list', label: 'Lead list / data' },
  { value: 'other', label: 'Other (describe in notes)' },
] as const

export const TECHNICAL_ISSUE_TAG_VALUES: Set<string> = new Set(
  TECHNICAL_ISSUE_TAGS.map((t) => t.value)
)

export function labelForTag(value: string): string {
  return TECHNICAL_ISSUE_TAGS.find((t) => t.value === value)?.label || value
}

/**
 * Parse a YYYY-MM-DD date string into a UTC Date at midnight — what Postgres
 * stores for a DATE column. Returns null on invalid input.
 */
export function parseReportDate(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim())
  if (!m) return null
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`)
  return isNaN(d.getTime()) ? null : d
}

/** YYYY-MM-DD for a Date, in UTC (matches how Prisma returns @db.Date). */
export function formatReportDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}
