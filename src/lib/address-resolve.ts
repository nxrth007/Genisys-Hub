import { createHash } from 'node:crypto'
import { prisma } from './prisma'
import { STATE_CODE_TO_NAME } from './address'
import { geocodeComponents } from './geocode'
import { isPoBox, parseUsAddress, type ResolvedAddress } from './address-parse'

export { parseUsAddress, type ResolvedAddress } from './address-parse'

/**
 * The parsed address with the geocoder filling the gaps — server side
 * (Prisma cache, network). The parser itself lives in address-parse.ts.
 */

const CACHE_TTL_MS = 30 * 86400_000
const cacheKey = (raw: string) => `address.resolve.${createHash('sha1').update(raw.trim().toLowerCase()).digest('hex').slice(0, 24)}`

/**
 * The parsed address, with the geocoder filling in whatever the text
 * didn't make clear (usually the city, or the state when only a ZIP or a
 * town was given). `zip`: look it up too when only the ZIP is missing (a
 * toll-free filing needs one). Never throws; worst case returns what the
 * text said.
 */
export async function resolveAddress(raw: string | null | undefined, opts: { zip?: boolean } = {}): Promise<ResolvedAddress> {
  const parsed = parseUsAddress(raw)
  if (!raw?.trim() || (parsed.city && parsed.state && (!opts.zip || parsed.zip))) return parsed
  const found = await lookup(raw)
  return found ? merge(parsed, found) : parsed
}

/**
 * An onboarding address made whole for a filing. One with a town, state or
 * ZIP goes to resolveAddress. A street that came with no town ("25 Woodlawn
 * ave") is looked up in `area`, where the business works ("Albany, NY"),
 * never anywhere in the country: the map has to find the street there (in
 * the area's state, or its city when it names no state). Otherwise only an
 * area that names its state lends its city and state. Never throws.
 */
export async function completeAddress(address: string | null | undefined, area: string, opts: { zip?: boolean } = {}): Promise<ResolvedAddress> {
  const parsed = parseUsAddress(address)
  if (parsed.city || parsed.state || parsed.zip) return isPoBox(address) ? parsed : resolveAddress(address, opts)
  const where = parseUsAddress(area)
  if (!where.city) return parsed
  const found = parsed.street && !isPoBox(parsed.street) ? await lookup(`${parsed.street}, ${area}`) : null
  const sameCity = (a: string, b: string) => a.toLowerCase().replace(/[^a-z]/g, '') === b.toLowerCase().replace(/[^a-z]/g, '')
  if (found?.street && found.state && (where.state ? found.state === where.state : sameCity(found.city, where.city))) {
    return { street: parsed.street, city: found.city || where.city, state: found.state, stateName: found.stateName, zip: found.zip, source: 'geocoded' }
  }
  return where.state ? { ...parsed, city: where.city, state: where.state, stateName: where.stateName, source: 'geocoded' } : parsed
}

/** The geocoder's reading of an address, remembered for 30 days. */
async function lookup(raw: string): Promise<ResolvedAddress | null> {
  const key = cacheKey(raw)
  try {
    const row = await prisma.appSetting.findUnique({ where: { key } })
    if (row) {
      const cached = JSON.parse(row.value) as ResolvedAddress & { at: string }
      if (Date.now() - Date.parse(cached.at) < CACHE_TTL_MS) return cached
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
  if (!geo) return null
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
  return found
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
