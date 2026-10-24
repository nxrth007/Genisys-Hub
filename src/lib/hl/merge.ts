import type { HlProfile } from './types'

/**
 * {{merge.fields}} in automation and message text, GHL style. Client-safe:
 * the builder previews with the same code the engine sends with.
 */

export type MergeContact = {
  firstName?: string | null
  lastName?: string | null
  phone?: string | null
  email?: string | null
  /** Form answers kept on the contact (JSON from the database). */
  fields?: unknown
}

export type MergeData = {
  contact?: MergeContact | null
  account?: HlProfile | null
  /** Answers of the form that fired the workflow, by field key. */
  form?: Record<string, unknown> | null
  /** The call that fired it: { from, to }. */
  call?: Record<string, unknown> | null
}

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()

/** "+16035551234" → "(603) 555-1234"; anything else unchanged. */
export function prettyPhone(p: string | null | undefined): string {
  const d = (p ?? '').replace(/\D/g, '')
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : (p ?? '')
}

function value(path: string, d: MergeData): string | null {
  const [scope, ...rest] = path.trim().toLowerCase().split('.')
  const key = rest.join('.').replace(/\s+/g, '_')
  const str = (v: unknown) => (v === null || v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v))
  if (scope === 'contact') {
    const c = d.contact ?? {}
    const full = [c.firstName, c.lastName].filter(Boolean).join(' ')
    switch (key) {
      case 'first_name':
        return c.firstName ?? ''
      case 'last_name':
        return c.lastName ?? ''
      case 'name':
      case 'full_name':
        return full
      case 'phone':
        return prettyPhone(c.phone)
      case 'email':
        return c.email ?? ''
      default:
        return str(c.fields && typeof c.fields === 'object' ? (c.fields as Record<string, unknown>)[key] : null)
    }
  }
  if (scope === 'account' || scope === 'custom_values') {
    const a = (d.account ?? {}) as Record<string, unknown>
    const hit = Object.keys(a).find((k) => snake(k) === key)
    const v = hit ? str(a[hit]) : ''
    return key.endsWith('phone') ? prettyPhone(v) : v
  }
  if (scope === 'form') return str((d.form ?? {})[key])
  if (scope === 'call') return key.endsWith('from') || key.endsWith('to') ? prettyPhone(str((d.call ?? {})[key])) : str((d.call ?? {})[key])
  return null
}

/**
 * Fill every {{scope.field}} in the text. Unknown scopes stay as written so a
 * typo shows up in the message preview; known scopes with no value go blank.
 */
export function renderTemplate(text: string, d: MergeData): string {
  return text
    .replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, path: string) => {
      const v = value(path, d)
      return v === null ? m : v
    })
    // "Hey ! Just got…" when there's no first name reads badly.
    .replace(/\b(Hey|Hi|Hello),?\s+([!,.])/g, '$1$2')
}

/** Merge tokens in the text that wouldn't fill (unknown scope). */
export function unknownTokens(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const scope = m[1].trim().toLowerCase().split('.')[0]
    if (!['contact', 'account', 'custom_values', 'form', 'call'].includes(scope)) out.push(m[0])
  }
  return out
}
