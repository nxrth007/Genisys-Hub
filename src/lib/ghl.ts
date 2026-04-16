/**
 * GoHighLevel API helper — vault-aware, multi-sub-account.
 *
 * Every vault entry tagged "ghl" is treated as a distinct GHL sub-account.
 * Each function takes a vault entry name (e.g. "GHL Genisys Token") to
 * identify which sub-account to hit.
 *
 * LocationId + location name are auto-discovered from the token on first
 * call and cached in-memory for 5 minutes.
 */
import { getSecretByName, listEntriesByTag } from './vault-service'

const BASE_URL = 'https://services.leadconnectorhq.com'
const API_VERSION = '2021-07-28'

// In-memory cache: vault entry name → resolved token + location info
type TokenInfo = {
  token: string
  locationId: string
  locationName: string
  expiresAt: number
}
const tokenCache = new Map<string, TokenInfo>()
const CACHE_TTL_MS = 5 * 60 * 1000

/**
 * GHL Private Integration tokens are JWTs that encode the locationId in
 * their payload. Decode the middle segment (base64url) to extract it —
 * no API call required. Much more reliable than /locations/search, which
 * has inconsistent behavior across account tiers.
 */
function decodeJwtLocationId(token: string): string | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const decoded = Buffer.from(b64, 'base64').toString('utf8')
    const payload = JSON.parse(decoded) as Record<string, unknown>
    const loc = payload.location_id ?? payload.locationId
    return typeof loc === 'string' ? loc : null
  } catch {
    return null
  }
}

/**
 * Derive a human-friendly display name from the vault entry name.
 * "GHL Spring Solar Token" → "Spring Solar"
 * "GHL Genisys Token"     → "Genisys"
 */
function friendlyNameFromVaultName(vaultName: string): string {
  return vaultName
    .replace(/^GHL\s+/i, '')
    .replace(/\s+Token$/i, '')
    .trim() || vaultName
}

async function resolveToken(vaultEntryName: string): Promise<TokenInfo> {
  const cached = tokenCache.get(vaultEntryName)
  if (cached && Date.now() < cached.expiresAt) return cached

  const token = await getSecretByName(vaultEntryName)

  // Try JWT decode first (Private Integration tokens).
  let locationId = decodeJwtLocationId(token)

  // If the token isn't a JWT, fall back to /locations/search (legacy API keys).
  if (!locationId) {
    const locRes = await fetch(`${BASE_URL}/locations/search`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Version: API_VERSION,
      },
    })
    if (!locRes.ok) {
      const text = await locRes.text()
      throw new Error(
        `GHL token "${vaultEntryName}" is neither a Private Integration JWT nor accepted by /locations/search (${locRes.status}): ${text}`
      )
    }
    const locData = await locRes.json()
    const locations = locData.locations || []
    if (locations.length === 0) {
      throw new Error(`No locations found for GHL token "${vaultEntryName}".`)
    }
    locationId = locations[0].id
  }

  if (!locationId) {
    throw new Error(`Could not determine locationId for GHL token "${vaultEntryName}".`)
  }

  const info: TokenInfo = {
    token,
    locationId,
    locationName: friendlyNameFromVaultName(vaultEntryName),
    expiresAt: Date.now() + CACHE_TTL_MS,
  }
  tokenCache.set(vaultEntryName, info)
  return info
}

async function ghlFetch(
  path: string,
  vaultEntryName: string,
  options: RequestInit = {}
): Promise<Record<string, unknown>> {
  const { token } = await resolveToken(vaultEntryName)

  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Version: API_VERSION,
      ...options.headers,
    },
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`GHL API error ${response.status}: ${text}`)
  }

  return response.json()
}

// -------------------------------------------------------------------------
// Sub-account discovery
// -------------------------------------------------------------------------

export type SubAccount = {
  vaultName: string
  locationId: string
  locationName: string
}

/**
 * List all GHL sub-accounts discovered from vault entries tagged "ghl".
 * Each entry is resolved to its GHL location (id + name). Failed lookups
 * (invalid token, etc.) are skipped rather than throwing the whole list.
 */
export async function listSubAccounts(): Promise<SubAccount[]> {
  const entries = await listEntriesByTag('ghl')
  const results: SubAccount[] = []

  for (const entry of entries) {
    try {
      const { locationId, locationName } = await resolveToken(entry.name)
      results.push({
        vaultName: entry.name,
        locationId,
        locationName,
      })
    } catch (err) {
      // Log but don't throw — one bad token shouldn't hide the others.
      console.warn(`[ghl] Failed to resolve "${entry.name}":`, err)
    }
  }

  return results
}

// -------------------------------------------------------------------------
// Calendar
// -------------------------------------------------------------------------

export async function getCalendars(vaultEntryName = 'GHL Genisys Token') {
  const { locationId } = await resolveToken(vaultEntryName)
  return ghlFetch(`/calendars/?locationId=${locationId}`, vaultEntryName)
}

export async function getCalendarEvents(
  calendarId: string,
  startTime: string,
  endTime: string,
  vaultEntryName = 'GHL Genisys Token'
) {
  const { locationId } = await resolveToken(vaultEntryName)
  const params = new URLSearchParams({ locationId, calendarId, startTime, endTime })
  return ghlFetch(`/calendars/events?${params}`, vaultEntryName)
}

export async function getTodayEvents(vaultEntryName = 'GHL Genisys Token') {
  const now = new Date()
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1)

  const calData = await getCalendars(vaultEntryName)
  const calendars = (calData.calendars || []) as Array<{ id: string; name: string }>

  type CalEvent = Record<string, unknown> & { calendarName: string; calendarId: string }
  let allEvents: CalEvent[] = []

  for (const cal of calendars) {
    try {
      const evData = await getCalendarEvents(
        cal.id,
        startOfDay.toISOString(),
        endOfDay.toISOString(),
        vaultEntryName
      )
      const events = (evData.events || []) as Record<string, unknown>[]
      allEvents = allEvents.concat(
        events.map((e) => ({
          ...e,
          calendarName: cal.name,
          calendarId: cal.id,
        }))
      )
    } catch {
      // skip
    }
  }

  allEvents.sort((a, b) => {
    const dateA = new Date(String(a.startTime || '1970-01-01')).getTime()
    const dateB = new Date(String(b.startTime || '1970-01-01')).getTime()
    return dateA - dateB
  })

  return { events: allEvents, calendars }
}

// -------------------------------------------------------------------------
// Contacts
// -------------------------------------------------------------------------

export async function getContact(contactId: string, vaultEntryName = 'GHL Genisys Token') {
  return ghlFetch(`/contacts/${contactId}`, vaultEntryName)
}

// -------------------------------------------------------------------------
// Conversations
// -------------------------------------------------------------------------

export async function getConversations(
  vaultEntryName: string,
  params: { limit?: number; cursor?: string } = {}
) {
  const { locationId } = await resolveToken(vaultEntryName)
  const search = new URLSearchParams({
    locationId,
    limit: String(params.limit ?? 20),
  })
  if (params.cursor) search.set('startAfterDate', params.cursor)
  return ghlFetch(`/conversations/search?${search}`, vaultEntryName)
}

export async function getConversation(
  conversationId: string,
  vaultEntryName: string
) {
  return ghlFetch(`/conversations/${conversationId}`, vaultEntryName)
}

export async function getConversationMessages(
  conversationId: string,
  vaultEntryName: string,
  limit = 50
) {
  const params = new URLSearchParams({ limit: String(limit) })
  return ghlFetch(`/conversations/${conversationId}/messages?${params}`, vaultEntryName)
}

export async function sendMessage(
  vaultEntryName: string,
  params: {
    conversationId: string
    contactId?: string
    message: string
    type?: 'Email' | 'SMS'
  }
) {
  return ghlFetch(`/conversations/messages`, vaultEntryName, {
    method: 'POST',
    body: JSON.stringify({
      type: params.type ?? 'Email',
      conversationId: params.conversationId,
      contactId: params.contactId,
      message: params.message,
    }),
  })
}
