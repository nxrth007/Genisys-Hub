/**
 * GoHighLevel API helper — vault-aware.
 *
 * Pulls tokens from the vault by name. For the Genisys sub-account the
 * expected vault entry name is "GHL Genisys Token".
 *
 * LocationId is auto-discovered from the token on first call and cached
 * in-memory for the lifetime of the server process.
 */
import { getSecretByName } from './vault-service'

const BASE_URL = 'https://services.leadconnectorhq.com'
const API_VERSION = '2021-07-28'

// In-memory cache: vault entry name → { token, locationId }
const tokenCache = new Map<string, { token: string; locationId: string; expiresAt: number }>()
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

async function resolveToken(vaultEntryName: string): Promise<{ token: string; locationId: string }> {
  const cached = tokenCache.get(vaultEntryName)
  if (cached && Date.now() < cached.expiresAt) {
    return { token: cached.token, locationId: cached.locationId }
  }

  const token = await getSecretByName(vaultEntryName)

  // Auto-discover locationId from the token.
  const locRes = await fetch(`${BASE_URL}/locations/search`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Version: API_VERSION,
    },
  })

  if (!locRes.ok) {
    const text = await locRes.text()
    throw new Error(`GHL location discovery failed (${locRes.status}): ${text}`)
  }

  const locData = await locRes.json()
  const locations = locData.locations || []
  if (locations.length === 0) {
    throw new Error(`No locations found for GHL token "${vaultEntryName}". Is the Private Integration token valid?`)
  }

  const locationId = locations[0].id as string

  tokenCache.set(vaultEntryName, {
    token,
    locationId,
    expiresAt: Date.now() + CACHE_TTL_MS,
  })

  return { token, locationId }
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

/**
 * Fetch today's events across all calendars for a given GHL sub-account.
 * Returns events sorted by start time (ascending — earliest first).
 */
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
      // Skip calendars that error
    }
  }

  // Sort by start time ascending (earliest first for a "today" view)
  allEvents.sort((a, b) => {
    const dateA = new Date(String(a.startTime || '1970-01-01')).getTime()
    const dateB = new Date(String(b.startTime || '1970-01-01')).getTime()
    return dateA - dateB
  })

  return { events: allEvents, calendars }
}

// -------------------------------------------------------------------------
// Contacts (for enriching calendar events)
// -------------------------------------------------------------------------

export async function getContact(contactId: string, vaultEntryName = 'GHL Genisys Token') {
  return ghlFetch(`/contacts/${contactId}`, vaultEntryName)
}

// -------------------------------------------------------------------------
// Conversations (for the CRM module later)
// -------------------------------------------------------------------------

export async function getConversations(
  limit = 20,
  vaultEntryName = 'GHL Genisys Token'
) {
  const { locationId } = await resolveToken(vaultEntryName)
  const params = new URLSearchParams({ locationId, limit: limit.toString() })
  return ghlFetch(`/conversations/search?${params}`, vaultEntryName)
}
