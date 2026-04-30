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
/**
 * Display formatter — finds phone-number-like substrings inside any
 * input text and formats each in place, leaving the surrounding text
 * (labels like "Mobile:" / "/HOME", commas, etc.) alone. Used when
 * rendering the Master Tracker rows where the customer-phone cell
 * has historically been free-form: some rows are bare 10-digit
 * strings ("8585683555"), others are spaced ("323 406 2186"),
 * others contain multiple numbers with labels ("Mobile: 3107148845
 * /HOME 3106351431").
 *
 * Anything that doesn't look like a phone number is left untouched.
 */
export function formatPhoneDisplay(raw: string | null | undefined): string {
  if (!raw) return ''
  const text = String(raw)
  return text.replace(PHONE_RE, (match) => formatPhoneInput(match) || match)
}

/**
 * Phone label (e.g. "Mobile", "Home"). Stored capitalized so the
 * display layer doesn't have to do casing work.
 */
export type PhoneEntry = {
  label: string | null
  /** Already formatted via formatPhoneInput. */
  number: string
}

/**
 * Pulls structured `{ label, number }` entries out of a free-text
 * phone field. Used by the Master Tracker phone cell so multi-number
 * rows render as a stacked list ("Mobile: (310) 714-8845" /
 * "Home: (310) 635-1431") instead of a single run-on string.
 *
 * Heuristic:
 *   1. Walk through every phone-number-like substring in order.
 *   2. For each one, look at the slice of text between this match
 *      and the previous match (or start). If that slice contains a
 *      label keyword (Mobile/Home/Cell/Work/Office/etc.), tag the
 *      number with that label.
 *   3. Format the number itself via formatPhoneInput.
 *
 * Returns `entries: []` when no phones are found, in which case
 * callers should render the original raw string verbatim.
 */
const PHONE_RE = /(?:\+?1[\s.\-]*)?\(?\d{3}\)?[\s.\-]*\d{3}[\s.\-]*\d{4}/g
const LABEL_RE =
  /\b(mobile|home|cell|work|office|primary|main|alt(?:ernate)?|other|fax)\b/i

export function parsePhoneEntries(raw: string | null | undefined): {
  entries: PhoneEntry[]
  raw: string
} {
  if (!raw) return { entries: [], raw: '' }
  const text = String(raw)

  const matches: Array<{ value: string; index: number }> = []
  // Reset lastIndex defensively — global regexes share state across
  // calls if you don't construct them fresh.
  PHONE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PHONE_RE.exec(text)) !== null) {
    matches.push({ value: m[0], index: m.index })
  }
  if (matches.length === 0) return { entries: [], raw: text }

  const entries: PhoneEntry[] = matches.map((p, i) => {
    const sliceStart =
      i === 0 ? 0 : matches[i - 1].index + matches[i - 1].value.length
    const between = text.slice(sliceStart, p.index)
    const labelMatch = between.match(LABEL_RE)
    const label = labelMatch
      ? labelMatch[1][0].toUpperCase() + labelMatch[1].slice(1).toLowerCase()
      : null
    return {
      label,
      number: formatPhoneInput(p.value) || p.value,
    }
  })
  return { entries, raw: text }
}

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
