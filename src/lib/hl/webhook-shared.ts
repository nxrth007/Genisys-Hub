import type { HlWebhookMapping } from './types'

/**
 * Reading an inbound webhook's request, shared by the engine and the builder
 * (no server imports): a field by its path, every path with a sample value
 * (the builder's field menu), and the contact's details.
 */

/** "items[0].name" and "items.0.name" alike. */
const partsOf = (path: string) =>
  path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((p) => p.trim())
    .filter((p) => p !== '')

function keyIn(o: Record<string, unknown>, want: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(o, want)) return want
  const low = want.toLowerCase()
  return Object.keys(o).find((k) => k.toLowerCase() === low)
}

/** The value at a path ("contact.email", "items.0.name"); key names match whatever their case. */
export function pathValue(root: unknown, path: string): unknown {
  const parts = partsOf(path)
  let cur: unknown = root
  let i = 0
  while (i < parts.length) {
    if (Array.isArray(cur)) {
      const n = Number(parts[i])
      if (!Number.isInteger(n)) return undefined
      cur = cur[n]
      i++
      continue
    }
    if (!cur || typeof cur !== 'object') return undefined
    const o = cur as Record<string, unknown>
    // A key can hold dots itself ("contact.email" sent flat): the longest run of parts that names a key wins.
    let hit: string | undefined
    let j = parts.length
    for (; j > i; j--) {
      hit = keyIn(o, parts.slice(i, j).join('.'))
      if (hit !== undefined) break
    }
    if (hit === undefined) return undefined
    cur = o[hit]
    i = j
  }
  return cur
}

/** A value as message text: lists of plain values joined with commas, anything bigger as JSON. */
export function webhookText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v) && v.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x))) return v.filter((x) => x !== null).join(', ')
  try {
    return JSON.stringify(v)
  } catch {
    return ''
  }
}

const short = (s: string) => (s.length > 80 ? `${s.slice(0, 77)}…` : s)

/** Every field of a request with a sample value, for {{inboundWebhookRequest.<path>}} (a list's first item stands for the rest). */
export function webhookPaths(payload: unknown, max = 150): { path: string; sample: string }[] {
  const out: { path: string; sample: string }[] = []
  const walk = (v: unknown, path: string, depth: number) => {
    if (out.length >= max) return
    if (v && typeof v === 'object' && depth < 6) {
      if (Array.isArray(v)) {
        if (path) out.push({ path, sample: short(webhookText(v)) })
        if (v[0] && typeof v[0] === 'object') walk(v[0], path ? `${path}.0` : '0', depth + 1)
        return
      }
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, path ? `${path}.${k}` : k, depth + 1)
      return
    }
    if (path) out.push({ path, sample: short(webhookText(v)) })
  }
  walk(payload, '', 0)
  return out
}

/** The merge token for a field ("" = the whole request). */
export const webhookToken = (path: string) => (path ? `{{inboundWebhookRequest.${path}}}` : '{{inboundWebhookRequest}}')

/** The merge token for a field of a Webhook action's kept response ("" = all of it). */
export const responseToken = (step: string, path: string) => `{{custom_webhook.${step}.response${path ? `.${path}` : ''}}}`

/**
 * Does a consent field say yes? The field is the one picked as consent, and
 * forms send a box only when it's ticked, so any value counts except the
 * plain no's (false, no, off, 0, blank…).
 */
export function isYes(v: unknown): boolean {
  if (v === true) return true
  if (typeof v === 'number') return v > 0
  if (typeof v === 'string') {
    const s = v.trim()
    return !!s && !/^(false|no|n|off|0|unchecked|none|null|undefined|declined?|opt(ed)?[-_ ]?out)$/i.test(s)
  }
  if (Array.isArray(v)) return v.some(isYes)
  return false
}

const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '')

/** The usual names, as they look with case and punctuation dropped. */
const NAMES: Record<'email' | 'phone' | 'firstName' | 'lastName' | 'fullName', string[]> = {
  email: ['email', 'emailaddress', 'contactemail', 'youremail', 'useremail', 'customeremail', 'leademail', 'mail'],
  phone: ['phone', 'phonenumber', 'mobile', 'mobilephone', 'mobilenumber', 'cell', 'cellphone', 'tel', 'telephone', 'contactphone', 'yourphone', 'customerphone', 'leadphone'],
  firstName: ['firstname', 'fname', 'givenname', 'first'],
  lastName: ['lastname', 'lname', 'familyname', 'surname', 'last'],
  fullName: ['name', 'fullname', 'contactname', 'yourname', 'customername', 'leadname'],
}

const looksLike = {
  email: (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
  phone: (s: string) => s.replace(/\D/g, '').length >= 7,
}

/** The first plain value whose key passes `test`: the top level first, then a few levels in. */
function findKey(payload: unknown, test: (key: string, value: string) => boolean): { path: string; value: string } | null {
  let level: { v: unknown; path: string }[] = [{ v: payload, path: '' }]
  for (let depth = 0; depth < 4 && level.length; depth++) {
    const next: { v: unknown; path: string }[] = []
    for (const { v, path } of level) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const p = path ? `${path}.${k}` : k
        if (typeof x === 'string' || typeof x === 'number') {
          const s = String(x).trim()
          if (s && test(k, s)) return { path: p, value: s }
        } else if (x && typeof x === 'object' && !Array.isArray(x)) next.push({ v: x, path: p })
      }
    }
    level = next
  }
  return null
}

export type WebhookContact = {
  email?: string
  phone?: string
  firstName?: string
  lastName?: string
  fullName?: string
  consent: boolean
  marketingConsent: boolean
  /** Where each detail was read from (a path in the request). */
  from: Partial<Record<keyof HlWebhookMapping, string>>
}

/** The contact's details in a request: from the mapped fields, else under their usual names. */
export function contactFromPayload(payload: unknown, mapping: HlWebhookMapping = {}): WebhookContact {
  const out: WebhookContact = { consent: false, marketingConsent: false, from: {} }
  for (const key of ['email', 'phone', 'firstName', 'lastName', 'fullName'] as const) {
    const mapped = mapping[key]?.trim()
    if (mapped) {
      const v = webhookText(pathValue(payload, mapped)).trim()
      if (v) {
        out[key] = v
        out.from[key] = mapped
      }
      continue
    }
    const names = NAMES[key]
    const check = key === 'email' || key === 'phone' ? looksLike[key] : () => true
    const hit =
      findKey(payload, (k, v) => names.includes(norm(k)) && check(v)) ??
      // "Customer E-mail", "Best phone to reach you": the kind is in the name.
      (key === 'email' ? findKey(payload, (k, v) => norm(k).endsWith('email') && check(v)) : null) ??
      (key === 'phone' ? findKey(payload, (k, v) => /phone|mobile|cell/.test(norm(k)) && check(v)) : null)
    if (hit) {
      out[key] = hit.value
      out.from[key] = hit.path
    }
  }
  for (const key of ['consent', 'marketingConsent'] as const) {
    const mapped = mapping[key]?.trim()
    if (!mapped) continue
    out[key] = isYes(pathValue(payload, mapped))
    out.from[key] = mapped
  }
  return out
}
