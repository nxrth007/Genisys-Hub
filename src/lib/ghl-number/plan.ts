/**
 * The GHL route of a client's toll-free number, pure so it is unit-tested:
 * phone formats, which number to buy, what's on screen after "Proceed to
 * Buy", which number the sub-account already has, and where calls ring.
 *
 * Seen in GHL on 2026-11-12:
 * - The buy list's rows read like "+1 855-465-6514 Toll Free None $2.15".
 * - Move Numbers lists numbers like "(855) 465-6514".
 * - GHL's identity check (Persona) says "We need some information to help us
 *   confirm your identity" with a "Begin verifying" button.
 * - A number's Edit Configuration shows "Business Phone Number 3rd Priority
 *   +16035026226" and an "External Phone Number" box.
 */
/** Any US/Canada form ("+1 855-465-6514", "(855) 465-6514", "8554656514") → "+18554656514"; '' when it isn't one. */
export function e164(raw: string | null | undefined): string {
  const d = (raw ?? '').replace(/\D/g, '')
  if (d.length === 10) return `+1${d}`
  if (d.length === 11 && d.startsWith('1')) return `+${d}`
  return ''
}

/** "+18554656514" → "(855) 465-6514", as Move Numbers lists it. */
export function displayNumber(number: string): string {
  const d = e164(number).slice(2)
  return d ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : number
}

export type BuyRow = { number: string; type: string; price: number | null; text: string }

/** One row of GHL's "Buy your Number" list. */
export function parseBuyRow(text: string): BuyRow | null {
  const flat = text.replace(/\s+/g, ' ').trim()
  const num = /\+1[\s(]*\d{3}[)\s-]*\d{3}[\s-]*\d{4}/.exec(flat)?.[0]
  if (!num) return null
  const number = e164(num)
  if (!number) return null
  const type = /toll\s*free/i.test(flat) ? 'Toll Free' : /\blocal\b/i.test(flat) ? 'Local' : /\bmobile\b/i.test(flat) ? 'Mobile' : 'Other'
  const priceMatch = /\$\s*(\d+(?:\.\d+)?)/.exec(flat)
  return { number, type, price: priceMatch ? Number(priceMatch[1]) : null, text: flat }
}

/** GHL's toll-free price in this agency was $2.15/mo; anything above this is not bought by itself. */
export const MAX_TOLL_FREE_PRICE = 2.5

/** The first toll-free number at a price the job may pay. */
export function pickTollFree(rows: (BuyRow | null)[], maxPrice = MAX_TOLL_FREE_PRICE): BuyRow | null {
  return rows.find((r): r is BuyRow => !!r && r.type === 'Toll Free' && r.price !== null && r.price > 0 && r.price <= maxPrice) ?? null
}

/** GHL's identity check (Persona) is on screen. Only a person may do it. */
export function isIdentityCheck(text: string): boolean {
  return /confirm your identity|begin verifying|identity verification|persona, our vendor|verify your identity/i.test(text)
}

/** The last button of a purchase, if GHL shows one after "Proceed to Buy". */
export const CONFIRM_BUY = /^(buy|buy now|buy number|buy numbers|purchase|purchase now|purchase number|confirm|confirm purchase|confirm & buy|confirm and buy|complete purchase|place order|pay now)$/i

/** Where a number's calls go, from the text of its Edit Configuration. */
export function forwardingFrom(text: string): { external: string; business: string } {
  const flat = text.replace(/\s+/g, ' ')
  const after = (label: string) => {
    const at = flat.search(new RegExp(label, 'i'))
    if (at < 0) return ''
    const tail = flat.slice(at + label.length, at + label.length + 120)
    const stop = tail.search(/Voice AI|Team Member|Ring more|IVR|Timeout|Business Phone Number|External Phone Number/i)
    return e164(/\+?1?[\s(]*\d{3}[)\s.-]*\d{3}[\s.-]*\d{4}/.exec(stop >= 0 ? tail.slice(0, stop) : tail)?.[0] ?? '')
  }
  return { external: after('External Phone Number'), business: after('Business Phone Number') }
}

/** At most this many numbers are bought in a day, so a bug can never buy a batch. */
export const DAILY_BUY_CAP = 5

export function underDailyCap(boughtLast24h: number, cap = DAILY_BUY_CAP): boolean {
  return boughtLast24h < cap
}

/** A row of the sub-account's Manage Numbers list. */
export type ListedNumber = { number: string; tollFree: boolean }

/**
 * The number this job takes instead of buying: the toll-free number already
 * in the sub-account (the one bought during GHL's ID check), else none. A
 * local number alone doesn't count; the client gets a toll-free one.
 */
export function adoptable(rows: ListedNumber[]): string | null {
  return rows.find((r) => r.tollFree && /^\+1\d{10}$/.test(r.number))?.number ?? null
}
