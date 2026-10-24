/**
 * Phone numbers as Hell-level stores them: E.164 (+16035551234). US/Canada
 * numbers typed any way ("(603) 555-1234", "603.555.1234", "1 603…") come
 * out the same; anything that can't be a dialable number comes out null.
 */
export function toE164(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  const digits = s.replace(/\D/g, '')
  if (s.startsWith('+')) return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null
  if (digits.length === 10 && /^[2-9]/.test(digits)) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return null
}

/** Several numbers in one field ("603-555-1234, 603-555-9876"). */
export function phoneList(raw: string | null | undefined): string[] {
  return [...new Set((raw ?? '').split(/[,;\n/]+/).map(toE164).filter((p): p is string => !!p))]
}

/** Several emails in one field. */
export function emailList(raw: string | null | undefined): string[] {
  return [...new Set((raw ?? '').split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))]
}

/** "Jane Q. Smith" → { firstName: "Jane", lastName: "Q. Smith" }. */
export function splitName(full: string | null | undefined): { firstName: string | null; lastName: string | null } {
  const parts = (full ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  if (!parts.length) return { firstName: null, lastName: null }
  const cap = (w: string) => (w === w.toLowerCase() || w === w.toUpperCase() ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w)
  return { firstName: cap(parts[0]), lastName: parts.length > 1 ? parts.slice(1).map(cap).join(' ') : null }
}
