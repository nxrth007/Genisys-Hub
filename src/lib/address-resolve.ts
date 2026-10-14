import { createHash } from 'node:crypto'
import { prisma } from './prisma'
import { STATE_CODE_TO_NAME, STATE_NAME_TO_CODE } from './address'
import { geocodeComponents } from './geocode'

/**
 * City, state, ZIP and street out of whatever a client typed as their
 * business address on the onboarding form — the only location they give.
 *
 * Clients write addresses every way there is: "1626 Sun Spur Dr, New
 * Braunfels, TX 78130", "123 Main St Minden NV 89423", "Rhome Texas",
 * "PO Box 921, Minden, NV", two lines, with or without a ZIP or "USA".
 * `parseUsAddress` reads those without a network call. When it can't tell
 * the city or state apart, `resolveAddress` asks the geocoder (the same
 * one that puts clients on the Home globe) and remembers the answer, so
 * each address is looked up once.
 */

export type ResolvedAddress = {
  street: string
  city: string
  /** Two-letter code, e.g. "TX". */
  state: string
  /** Full name, e.g. "Texas". */
  stateName: string
  zip: string
  /** parsed: read from the text. geocoded: the geocoder filled what the text didn't say. none: nothing usable. */
  source: 'parsed' | 'geocoded' | 'none'
}

const EMPTY: ResolvedAddress = { street: '', city: '', state: '', stateName: '', zip: '', source: 'none' }

const STATE_CODES = new Set([...Object.values(STATE_NAME_TO_CODE), 'DC'])
const STATE_NAMES: Array<[string, string]> = [
  ...Object.entries(STATE_NAME_TO_CODE),
  ['district of columbia', 'DC'],
  ['washington dc', 'DC'],
  ['washington d.c.', 'DC'],
].sort((a, b) => b[0].length - a[0].length) as Array<[string, string]>

const STREET_SUFFIX =
  /\b(?:st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|ln|lane|ct|court|cir|circle|way|hwy|highway|pkwy|parkway|pl|place|trl|trail|ter|terrace|loop|run|pike|plaza|sq|square|path|pass|row|xing|crossing|bend|cv|cove|pt|point|ridge|hollow|expy|expressway|fwy|freeway|tpke|turnpike|byp|bypass|rte|route|fm\s*\d+|cr\s*\d+|box)\b\.?/i
const UNIT = /\b(?:ste|suite|apt|apartment|unit|bldg|building|fl|floor|rm|room|#)\s*[A-Za-z0-9-]+\b\.?/gi
/** Second-to-last word that usually belongs to a two-word city ("Fort Worth", "New Braunfels", "Carson City"). */
const CITY_PREFIX = new Set(
  'fort ft san santa new north south east west los las el st saint mount mt lake port grand cape palm royal little big red rock sugar round cedar spring silver green glen oak pine salt long carson smith rio del de la le des bay sun valley eagle twin wild deer elk falls highland hidden mission oro pleasant rancho west'.split(' '),
)

const title = (s: string) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase())
const clean = (s: string) => s.replace(/\s+/g, ' ').replace(/^[\s,.-]+|[\s,.-]+$/g, '').trim()

/** Read street, city, state and ZIP from free text. Fields it can't tell stay empty. */
export function parseUsAddress(raw: string | null | undefined): ResolvedAddress {
  if (!raw?.trim()) return { ...EMPTY }
  let s = raw.replace(/\r?\n+/g, ', ').replace(/\s+/g, ' ').trim()
  s = s.replace(/[\s,]*(?:u\.?s\.?a?\.?|united states(?: of america)?)\.?\s*$/i, '').trim()

  // ZIP: the last five-digit group that isn't the house number at the start.
  let zip = ''
  for (const m of s.matchAll(/\b(\d{5})(?:-\d{4})?\b/g)) {
    if (m.index && m.index > 0) zip = m[1]
  }
  const beforeZip = zip ? s.slice(0, s.lastIndexOf(zip)).trim() : s

  // State: a full name anywhere (last one wins), else a code that ends the
  // text or sits before the ZIP / a comma. "Ct" at the end of a street is
  // Court, so a code right after a street suffix doesn't count.
  let state = ''
  let stateAt = -1
  let stateLen = 0
  // A code that ends the text (before the ZIP) is the strongest signal:
  // "Minden NV 89423", "Washington, DC 20001", "Rhome, TX". Without a
  // comma or ZIP, "12 Oak Ct" is Court, not Connecticut.
  const trailing = /(?:^|[\s,])([A-Za-z]{2})\.?\s*$/.exec(beforeZip)
  if (trailing && STATE_CODES.has(trailing[1].toUpperCase())) {
    const code = trailing[1].toUpperCase()
    const before = beforeZip.slice(0, trailing.index).trim()
    const afterComma = /,$/.test(before)
    const looksLikeStreetSuffix = !afterComma && !zip && /^\d/.test(before) && /^(ct|st|dr|ln|pl|rd|co|in|or|de|me|ok|hi)$/i.test(trailing[1])
    const prevIsSuffix = !afterComma && !zip && STREET_SUFFIX.test(before.split(/\s+/).slice(-1)[0] ?? '')
    if (!looksLikeStreetSuffix && !prevIsSuffix) {
      state = code
      stateAt = trailing.index + (trailing[0].length - trailing[0].replace(/^[\s,]/, '').length)
      stateLen = trailing[1].length
    }
  }
  for (const [name, code] of state ? [] : STATE_NAMES) {
    const re = new RegExp(`(?:^|[\\s,])(${name.replace('.', '\\.')})(?=[\\s,.]*$|[\\s,.]+)`, 'gi')
    let m: RegExpExecArray | null
    let last: RegExpExecArray | null = null
    while ((m = re.exec(beforeZip))) last = m
    if (last && last.index + last[0].length - last[1].length > stateAt) {
      state = code
      stateAt = last.index + (last[0].length - last[1].length)
      stateLen = last[1].length
    }
  }

  const head = clean(stateAt >= 0 ? beforeZip.slice(0, stateAt) : beforeZip)
  let city = ''
  let street = ''
  if (head) {
    const parts = head.split(',').map(clean).filter(Boolean)
    if (parts.length >= 2) {
      city = parts[parts.length - 1]
      street = parts.slice(0, -1).join(', ')
    } else {
      // No commas: "123 Main St Minden", "PO Box 921 Minden", "Minden".
      const text = parts[0] ?? ''
      const noUnits = text.replace(UNIT, ' ').replace(/\s+/g, ' ').trim()
      const words = noUnits.split(' ')
      let suffixAt = -1
      for (let i = words.length - 2; i >= 0; i--) {
        if (STREET_SUFFIX.test(words[i]) && !/^\d/.test(words[i]) && i >= 1) {
          suffixAt = i
          break
        }
      }
      if (/^\d/.test(words[0]) && STREET_SUFFIX.test(words[words.length - 1]) && words.length <= 5) {
        // "12 Oak Ct": a street and nothing after it.
        street = text
      } else if (suffixAt >= 0) {
        // "PO Box 921 Minden", "Hwy 290 Dripping Springs": the number after the suffix is still the street.
        let cityFrom = suffixAt + 1
        while (cityFrom < words.length && /^\d+[A-Za-z]?$/.test(words[cityFrom])) cityFrom++
        city = words.slice(cityFrom).join(' ')
        const streetWords = words.slice(0, cityFrom)
        street = text.slice(0, text.toLowerCase().indexOf(streetWords[streetWords.length - 1].toLowerCase(), 0) + streetWords[streetWords.length - 1].length)
        // Units after the suffix belong to the street, not the city.
        const unitTail = text.slice(street.length).match(new RegExp(`^\\s*(?:${UNIT.source})`, 'i'))
        if (unitTail) {
          street = text.slice(0, street.length + unitTail[0].length)
          city = clean(text.slice(street.length))
        }
      } else if (!/^\d/.test(words[0]) && words.length <= 4) {
        city = noUnits
      } else if (words.length >= 2) {
        const two = CITY_PREFIX.has(words[words.length - 2].toLowerCase().replace('.', ''))
        city = words.slice(two ? -2 : -1).join(' ')
        street = words.slice(0, two ? -2 : -1).join(' ')
      }
    }
  }
  city = clean(city.replace(UNIT, ' '))
  if (/^\d/.test(city) || /^(po|p\.o\.)\s*box/i.test(city)) {
    // "PO Box 921" or a bare number is never a city.
    street = clean([street, city].filter(Boolean).join(', '))
    city = ''
  }
  if (city && city === city.toLowerCase()) city = title(city)
  if (city && city === city.toUpperCase() && city.length > 3) city = title(city.toLowerCase())

  const out: ResolvedAddress = {
    street: clean(street),
    city,
    state,
    stateName: state ? (STATE_CODE_TO_NAME[state] ?? (state === 'DC' ? 'District of Columbia' : state)) : '',
    zip,
    source: city || state || zip ? 'parsed' : 'none',
  }
  void stateLen
  return out
}

const CACHE_TTL_MS = 30 * 86400_000
const cacheKey = (raw: string) => `address.resolve.${createHash('sha1').update(raw.trim().toLowerCase()).digest('hex').slice(0, 24)}`

/**
 * The parsed address, with the geocoder filling in whatever the text
 * didn't make clear (usually the city, or the state when only a ZIP or a
 * town was given). Never throws; worst case returns what the text said.
 */
export async function resolveAddress(raw: string | null | undefined): Promise<ResolvedAddress> {
  const parsed = parseUsAddress(raw)
  if (!raw?.trim() || (parsed.city && parsed.state)) return parsed

  const key = cacheKey(raw)
  try {
    const row = await prisma.appSetting.findUnique({ where: { key } })
    if (row) {
      const cached = JSON.parse(row.value) as ResolvedAddress & { at: string }
      if (Date.now() - Date.parse(cached.at) < CACHE_TTL_MS) return merge(parsed, cached)
    }
  } catch {
    // The cache is a convenience; a bad row just means a fresh lookup.
  }

  let geo: Awaited<ReturnType<typeof geocodeComponents>> = null
  try {
    geo = await geocodeComponents(raw)
  } catch {
    geo = null
  }
  if (!geo) return parsed
  const found: ResolvedAddress = {
    street: geo.street ?? '',
    city: geo.city ?? '',
    state: geo.state ?? '',
    stateName: geo.state ? (STATE_CODE_TO_NAME[geo.state] ?? geo.state) : '',
    zip: geo.zip ?? '',
    source: 'geocoded',
  }
  const value = JSON.stringify({ ...found, at: new Date().toISOString() })
  await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } }).catch(() => undefined)
  return merge(parsed, found)
}

/** What the text says wins; the geocoder fills the gaps. */
function merge(parsed: ResolvedAddress, geo: ResolvedAddress): ResolvedAddress {
  const state = parsed.state || geo.state
  return {
    street: parsed.street || geo.street,
    city: parsed.city || geo.city,
    state,
    stateName: state ? (STATE_CODE_TO_NAME[state] ?? state) : '',
    zip: parsed.zip || geo.zip,
    source: parsed.city && parsed.state ? 'parsed' : geo.city || geo.state ? 'geocoded' : parsed.source,
  }
}
