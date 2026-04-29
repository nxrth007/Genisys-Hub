/**
 * Live phone-number formatter used by the agent booking form. Strips
 * everything but digits, then groups into the canonical US format:
 *
 *   raw            → formatted
 *   ""             → ""
 *   "5"            → "(5"
 *   "555"          → "(555"
 *   "5551"         → "(555) 1"
 *   "555123"       → "(555) 123"
 *   "5551234567"   → "(555) 123-4567"
 *   "15551234567"  → "+1 (555) 123-4567"
 *
 * Anything past 11 digits is truncated. Pasted values in any format
 * (dashes, dots, spaces, "+1") all normalize through the same path.
 *
 * Cursor position is *not* preserved — when an agent types forward
 * (the common case) the cursor naturally lands at the end after each
 * keystroke, which feels right. Repositioning mid-string is a rare
 * edit case we'd over-engineer for.
 */
export function formatPhoneInput(raw: string | null | undefined): string {
  if (!raw) return ''
  let digits = String(raw).replace(/\D/g, '')

  let prefix = ''
  if (digits.length === 11 && digits[0] === '1') {
    prefix = '+1 '
    digits = digits.slice(1)
  } else if (digits.length > 10) {
    // More than 10 digits without a leading 1 — keep the last 10
    // (assume the agent fat-fingered an extra digit at the front).
    digits = digits.slice(-10)
  }

  if (digits.length === 0) return prefix
  if (digits.length <= 3) return `${prefix}(${digits}`
  if (digits.length <= 6) {
    return `${prefix}(${digits.slice(0, 3)}) ${digits.slice(3)}`
  }
  return `${prefix}(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`
}
