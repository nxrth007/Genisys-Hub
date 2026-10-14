import { createHash } from 'node:crypto'
import { prisma } from './prisma'
import { STATE_CODE_TO_NAME } from './address'
import { geocodeComponents } from './geocode'
import { parseUsAddress, type ResolvedAddress } from './address-parse'

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
