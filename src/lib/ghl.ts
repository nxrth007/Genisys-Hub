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
 * GHL tokens (Private Integration, Company-level, sub-account) are JWTs
 * encoding location/company identifiers in their payload. Field names vary
 * between token types — we try the known variants. Returns both the found
 * locationId and the payload structure (keys only, for diagnostics).
 */
function decodeJwtPayload(token: string): {
  locationId: string | null
  keys: string[]
  companyId: string | null
} {
  const parts = token.split('.')
  if (parts.length !== 3) return { locationId: null, keys: [], companyId: null }
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const decoded = Buffer.from(b64, 'base64').toString('utf8')
    const payload = JSON.parse(decoded) as Record<string, unknown>

    // Try every known GHL field that might hold a location ID.
    const candidateFields = [
      'location_id',
      'locationId',
      'locId',
      'primaryAuthClassId', // used by some OAuth-style GHL tokens
      'authClassId',
      'sub', // fallback
    ]
    let locationId: string | null = null
    for (const field of candidateFields) {
      const val = payload[field]
      if (typeof val === 'string' && val.length > 0) {
        locationId = val
        break
      }
    }

    const companyCandidates = ['company_id', 'companyId']
    let companyId: string | null = null
    for (const field of companyCandidates) {
      const val = payload[field]
      if (typeof val === 'string' && val.length > 0) {
        companyId = val
        break
      }
    }

    return {
      locationId,
      keys: Object.keys(payload),
      companyId,
    }
  } catch {
    return { locationId: null, keys: [], companyId: null }
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

/**
 * Extract an explicit locationId from the vault entry's description field.
 * Escape hatch for tokens whose JWT doesn't expose one and whose scopes
 * don't allow /locations/search. User writes `locationId=abc123` or just
 * `abc123` in the description.
 */
async function locationIdFromDescription(vaultEntryName: string): Promise<string | null> {
  const { prisma } = await import('./prisma')
  const entry = await prisma.vaultEntry.findFirst({
    where: { name: vaultEntryName },
    select: { description: true },
  })
  const desc = entry?.description?.trim() || ''
  if (!desc) return null

  // Try "locationId=..." or "location_id=..." patterns first
  const explicit = desc.match(/location[_-]?id\s*[=:]\s*([A-Za-z0-9_-]+)/i)
  if (explicit) return explicit[1]

  // Otherwise, if the description looks like a single GHL-style ID token,
  // use it as-is (alphanumeric, ~18 chars or UUID-ish).
  if (/^[A-Za-z0-9_-]{10,40}$/.test(desc)) return desc

  return null
}

async function resolveToken(vaultEntryName: string): Promise<TokenInfo> {
  const cached = tokenCache.get(vaultEntryName)
  if (cached && Date.now() < cached.expiresAt) return cached

  const token = await getSecretByName(vaultEntryName)

  // Try 1: decode JWT, look for known location field names
  const jwt = decodeJwtPayload(token)
  let locationId: string | null = jwt.locationId

  // Try 2: explicit locationId in the vault entry's description field
  if (!locationId) {
    locationId = await locationIdFromDescription(vaultEntryName)
  }

  // Try 3: fall back to /locations/search (requires locations.readonly scope)
  if (!locationId) {
    const locRes = await fetch(`${BASE_URL}/locations/search`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Version: API_VERSION,
      },
    })
    if (locRes.ok) {
      const locData = await locRes.json()
      const locations = locData.locations || []
      if (locations.length > 0) locationId = locations[0].id
    }
  }

  if (!locationId) {
    // Build a diagnostic message naming what we actually saw.
    const hints: string[] = []
    if (jwt.keys.length > 0) {
      hints.push(`JWT payload fields: [${jwt.keys.join(', ')}]`)
    } else {
      hints.push('token is not a JWT')
    }
    if (jwt.companyId) {
      hints.push(`token is company-scoped (company_id=${jwt.companyId}), not location-scoped`)
    }
    hints.push('fallback /locations/search also failed (403 or empty)')
    throw new Error(
      `Cannot determine locationId for "${vaultEntryName}". ${hints.join('. ')}. ` +
        `Fix: edit the vault entry and put the locationId in the Description field ` +
        `(either "locationId=YOUR_ID" or just the raw ID). Find it in GHL under ` +
        `Sub-account → Settings → Business Profile → Location Id.`
    )
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
 * (invalid token, etc.) are reported separately instead of hiding the
 * whole list — UI can display per-entry errors.
 */
export async function listSubAccounts(): Promise<{
  subaccounts: SubAccount[]
  errors: Array<{ vaultName: string; error: string }>
  discoveredEntries: number
}> {
  const rawEntries = await listEntriesByTag('ghl')

  // Sort so the agency's own sub-account (tagged "primary" or "Genisys", or
  // simply not tagged "client") comes first, then clients alphabetically.
  const entries = [...rawEntries].sort((a, b) => {
    const tagsA = a.tags.map((t) => t.toLowerCase())
    const tagsB = b.tags.map((t) => t.toLowerCase())
    const isClientA = tagsA.includes('client')
    const isClientB = tagsB.includes('client')
    if (isClientA !== isClientB) return isClientA ? 1 : -1
    return a.name.localeCompare(b.name)
  })

  const subaccounts: SubAccount[] = []
  const errors: Array<{ vaultName: string; error: string }> = []

  for (const entry of entries) {
    try {
      const { locationId, locationName } = await resolveToken(entry.name)
      subaccounts.push({
        vaultName: entry.name,
        locationId,
        locationName,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[ghl] Failed to resolve "${entry.name}": ${msg}`)
      errors.push({ vaultName: entry.name, error: msg })
    }
  }

  return { subaccounts, errors, discoveredEntries: entries.length }
}

// -------------------------------------------------------------------------
// Calendar
// -------------------------------------------------------------------------

export async function getCalendars(vaultEntryName = 'GHL Genisys Token') {
  const { locationId } = await resolveToken(vaultEntryName)
  return ghlFetch(`/calendars/?locationId=${locationId}`, vaultEntryName)
}

/**
 * Converts an ISO datetime string to a Unix-ms string if needed.
 * GHL's /calendars/events endpoint requires startTime/endTime as
 * Unix milliseconds strings, NOT ISO. Accept either input format here.
 */
function toGhlTime(value: string): string {
  // Already numeric? Use as-is.
  if (/^\d+$/.test(value)) return value
  const ms = new Date(value).getTime()
  if (isNaN(ms)) throw new Error(`Invalid date: ${value}`)
  return ms.toString()
}

export async function getCalendarEvents(
  calendarId: string,
  startTime: string,
  endTime: string,
  vaultEntryName = 'GHL Genisys Token'
) {
  const { locationId } = await resolveToken(vaultEntryName)
  const params = new URLSearchParams({
    locationId,
    calendarId,
    startTime: toGhlTime(startTime),
    endTime: toGhlTime(endTime),
  })
  return ghlFetch(`/calendars/events?${params}`, vaultEntryName)
}

type EnrichedEvent = Record<string, unknown> & {
  subAccountName: string
  vaultName: string
  contactName?: string
  contactEmail?: string
  contactPhone?: string
}

/**
 * Fetch events from every GHL sub-account in a given date range, then
 * enrich each event with its contact's name/email/phone (if the event
 * has a contactId). Contact lookups are batched 5 at a time per sub-account
 * to avoid rate limits, and a per-request cache prevents duplicate fetches.
 */
export async function getEventsAcrossSubAccounts(
  startTime: string,
  endTime: string
): Promise<{
  events: EnrichedEvent[]
  subAccounts: SubAccount[]
}> {
  const { subaccounts } = await listSubAccounts()

  const allEvents: EnrichedEvent[] = []

  await Promise.all(
    subaccounts.map(async (sub) => {
      try {
        const calData = await getCalendars(sub.vaultName)
        const calendars = (calData.calendars || []) as Array<{ id: string; name: string }>

        await Promise.all(
          calendars.map(async (cal) => {
            try {
              const evData = await getCalendarEvents(cal.id, startTime, endTime, sub.vaultName)
              const events = (evData.events || []) as Record<string, unknown>[]
              for (const ev of events) {
                allEvents.push({
                  ...ev,
                  calendarName: cal.name,
                  calendarId: cal.id,
                  subAccountName: sub.locationName,
                  vaultName: sub.vaultName,
                })
              }
            } catch {
              // Skip calendars that error
            }
          })
        )
      } catch {
        // Skip sub-accounts that error
      }
    })
  )

  // Contact enrichment — batch by sub-account, 5 at a time. Cache by
  // "vaultName:contactId" so repeat contacts across events are fetched once.
  const contactCache = new Map<
    string,
    { name: string; email: string; phone: string }
  >()

  // Group events by sub-account so contact lookups use the correct token.
  const byVault = new Map<string, EnrichedEvent[]>()
  for (const ev of allEvents) {
    if (!ev.contactId) continue
    const list = byVault.get(ev.vaultName) || []
    list.push(ev)
    byVault.set(ev.vaultName, list)
  }

  for (const [vaultName, eventsForSub] of byVault) {
    // Walk events in batches of 5 for this sub-account
    for (let i = 0; i < eventsForSub.length; i += 5) {
      const batch = eventsForSub.slice(i, i + 5)
      await Promise.all(
        batch.map(async (ev) => {
          const cid = String(ev.contactId)
          const cacheKey = `${vaultName}:${cid}`

          let info = contactCache.get(cacheKey)
          if (!info) {
            try {
              const data = await getContact(cid, vaultName)
              const contact =
                ((data.contact as Record<string, unknown>) || data) as Record<string, unknown>
              info = {
                name:
                  (contact.name as string) ||
                  [contact.firstName, contact.lastName].filter(Boolean).join(' ') ||
                  '',
                email: (contact.email as string) || '',
                phone: (contact.phone as string) || '',
              }
              contactCache.set(cacheKey, info)
            } catch {
              return // skip enrichment on lookup failure
            }
          }

          ev.contactName = info.name || undefined
          ev.contactEmail = info.email || undefined
          ev.contactPhone = info.phone || undefined
        })
      )
    }
  }

  // Sort earliest first
  allEvents.sort((a, b) => {
    const da = new Date(String(a.startTime || '1970-01-01')).getTime()
    const db = new Date(String(b.startTime || '1970-01-01')).getTime()
    return da - db
  })

  return { events: allEvents, subAccounts: subaccounts }
}

/** Fetch GHL calendar events between two arbitrary timestamps. The
 *  Today page's calendar pill uses this to scope "Next up" to the
 *  picked date range instead of being hard-pinned to the current day.
 *  start / end are ISO strings (UTC); the caller is responsible for
 *  computing them in the correct user timezone. */
export async function getCalendarEventsInRange(
  vaultEntryName = 'GHL Genisys Token',
  range: { start: string; end: string },
) {
  const calData = await getCalendars(vaultEntryName)
  const calendars = (calData.calendars || []) as Array<{ id: string; name: string }>

  type CalEvent = Record<string, unknown> & { calendarName: string; calendarId: string }
  let allEvents: CalEvent[] = []

  for (const cal of calendars) {
    try {
      const evData = await getCalendarEvents(
        cal.id,
        range.start,
        range.end,
        vaultEntryName,
      )
      const events = (evData.events || []) as Record<string, unknown>[]
      allEvents = allEvents.concat(
        events.map((e) => ({
          ...e,
          calendarName: cal.name,
          calendarId: cal.id,
        })),
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

export async function getTodayEvents(
  vaultEntryName = 'GHL Genisys Token',
  options: { timeZone?: string } = {}
) {
  // Compute the day window in the *user's* timezone, not the server's.
  // Render runs in UTC, so without this the window rolls over at midnight
  // UTC — meaning at ~8 PM Eastern we'd start showing tomorrow's events.
  const timeZone = options.timeZone || 'America/New_York'
  const now = new Date()
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now) // "YYYY-MM-DD" in the target tz
  const { fromZonedTime } = await import('date-fns-tz')
  const startOfDay = fromZonedTime(`${ymd}T00:00:00`, timeZone)
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
  params: { limit?: number; cursor?: string; contactId?: string } = {}
) {
  const { locationId } = await resolveToken(vaultEntryName)
  const search = new URLSearchParams({
    locationId,
    limit: String(params.limit ?? 20),
  })
  if (params.cursor) search.set('startAfterDate', params.cursor)
  // contactId filter — used by the contact-centric thread view to
  // pull every conversation tied to a single contact (SMS, email,
  // call records often live in separate conversation containers in
  // GHL even when they're with the same person).
  if (params.contactId) search.set('contactId', params.contactId)
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

/**
 * Fetch a single email message by ID from GHL. The conversations
 * messages list endpoint returns email metadata (id, type, dates,
 * direction) but NOT the body for inbound emails — those need a
 * separate call here to surface the actual content. Used by the
 * thread-view endpoint to hydrate empty-body emails before sending
 * the response to the page.
 *
 * Returns the message object with `body` populated when GHL has it.
 * 404 / scope-denied errors surface as exceptions so callers can
 * fall through to the empty-body placeholder gracefully.
 */
export async function getEmailMessage(
  emailMessageId: string,
  vaultEntryName: string,
) {
  return ghlFetch(
    `/conversations/messages/email/${emailMessageId}`,
    vaultEntryName,
  )
}

/** Shape of a single message entry inside a GHL conversation. The
 *  fields here are the ones we read; GHL returns more (attachments,
 *  email metadata, status flags) that we ignore. */
export type ConversationMessage = {
  id?: string
  body?: string
  type?: string
  direction?: 'inbound' | 'outbound'
  dateAdded?: string
  contactId?: string
  conversationId?: string
  source?: string
  status?: string
  messageType?: string
}

export async function sendMessage(
  vaultEntryName: string,
  params: {
    conversationId: string
    contactId?: string
    message: string
    type?: 'Email' | 'SMS'
    /** Optional E.164 sender number — same fromNumber semantics as
     *  sendSmsToPhone. Manual SMS replies pass this so they go from
     *  the agency reminder line, not GHL's location default. */
    fromNumber?: string
  }
) {
  return ghlFetch(`/conversations/messages`, vaultEntryName, {
    method: 'POST',
    body: JSON.stringify({
      type: params.type ?? 'Email',
      conversationId: params.conversationId,
      contactId: params.contactId,
      message: params.message,
      ...(params.fromNumber ? { fromNumber: params.fromNumber } : {}),
    }),
  })
}

// -------------------------------------------------------------------------
// SMS via GHL — upsert a contact by phone, then send an SMS to them via
// the /conversations/messages endpoint. Used by the scheduled morning
// brief when the chosen delivery channel is 'ghl_sms'.
// -------------------------------------------------------------------------

function normalizePhone(raw: string): string {
  // Keep a leading +, strip everything else that isn't a digit.
  const trimmed = raw.trim()
  const digits = trimmed.replace(/[^\d+]/g, '')
  if (digits.startsWith('+')) return digits
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return digits
}

/**
 * Best-effort find of an existing GHL contact by phone number. Returns
 * null when no match OR when the search endpoint errors out (we fall
 * back to "treat as new contact" in that case — slightly worse than
 * a real find-first miss, but avoids hanging the upsert path on a
 * transient GHL outage).
 *
 * Used by upsertContactByPhone so SMS sends to a phone that already
 * has a GHL contact skip the upsert call entirely. GHL's
 * /contacts/upsert is destructive: it overwrites firstName / lastName
 * / companyName / etc. with whatever we pass when the contact already
 * exists. That cost Alex a renamed contact ("Brett Cooper" → "Sunny
 * Sky Solar Cooper") on 2026-05-13 when a client-alert send
 * coincidentally matched an existing contact at a different person's
 * phone. Find-first eliminates that whole class of bug.
 */
export async function findContactByPhone(
  vaultEntryName: string,
  phone: string,
): Promise<{ id: string } | null> {
  try {
    const { locationId } = await resolveToken(vaultEntryName)
    const normalizedPhone = normalizePhone(phone)
    const search = new URLSearchParams({
      locationId,
      query: normalizedPhone,
      limit: '1',
    })
    const res = (await ghlFetch(
      `/contacts/?${search.toString()}`,
      vaultEntryName,
      { method: 'GET' },
    )) as { contacts?: Array<{ id: string; phone?: string }> }
    const matches = res.contacts ?? []
    if (matches.length === 0) return null
    // Defensive: GHL's `query` does substring match on multiple
    // fields, so confirm the matched contact actually has this phone
    // before claiming a hit. Normalize both sides for comparison.
    const targetDigits = normalizedPhone.replace(/\D/g, '').slice(-10)
    const confirmed = matches.find((c) => {
      const d = (c.phone ?? '').replace(/\D/g, '').slice(-10)
      return d.length === 10 && d === targetDigits
    })
    return confirmed ? { id: confirmed.id } : null
  } catch (err) {
    console.warn(
      '[ghl] findContactByPhone error (treating as no existing contact):',
      err,
    )
    return null
  }
}

/**
 * Upsert a GHL contact by phone number. Three layers of safety:
 *
 *   1. Find existing contact by phone first (cheap GET).
 *      If found → return its id, never touch any fields.
 *
 *   2. If find-first returns nothing, do a SECOND lookup via the
 *      `/contacts/upsert` endpoint itself with phone only (no name
 *      fields). GHL's upsert returns the existing contact's id if
 *      one already exists at that phone — but since we passed no
 *      name fields, nothing gets overwritten. This is the "GHL
 *      itself confirmed there's no contact" round.
 *
 *   3. Only if step 2 returns a brand-new contact id (i.e. GHL
 *      actually created it) do we run a final PATCH that sets the
 *      firstName / lastName / companyName / email fields the caller
 *      provided. This guarantees we never overwrite an existing
 *      contact's fields, even if step 1 had a false negative
 *      because the find-first endpoint's `query` substring search
 *      missed the contact.
 *
 * Result: even if findContactByPhone silently fails to match an
 * existing contact (GHL API quirk, weird normalization, whatever),
 * the upsert call itself can't corrupt that contact's name fields
 * because we don't pass them.
 *
 * Was renamed-Brett-Cooper-Sunny-Sky / William-Pagani-Home-Energy-
 * Upgrade bug on 2026-05-13 — same root cause for both.
 */
export async function upsertContactByPhone(
  vaultEntryName: string,
  params: {
    phone: string
    firstName?: string
    lastName?: string
    email?: string
    /** GHL's "Business name" field on the contact. Pass the agency
     *  client's business name here (Sunny Sky Solar, Pro Energy
     *  Savers, etc.) so the GHL contact carries proper company
     *  metadata. */
    companyName?: string
  },
): Promise<{ id: string }> {
  const phone = normalizePhone(params.phone)

  // Layer 1: explicit find via GET /contacts/?query=<phone>.
  const existing = await findContactByPhone(vaultEntryName, phone)
  if (existing) return existing

  // Layer 2: defensive upsert with phone ONLY. If GHL already has
  // a contact at this phone (i.e. our find-first missed it), this
  // call returns that contact's id without touching its name
  // fields — because we passed none. If GHL truly has no contact,
  // this creates one with no name, and we name it in layer 3.
  const { locationId } = await resolveToken(vaultEntryName)
  const probeRes = (await ghlFetch('/contacts/upsert', vaultEntryName, {
    method: 'POST',
    body: JSON.stringify({ locationId, phone }),
  })) as {
    contact?: { id?: string; new?: boolean }
    id?: string
    new?: boolean
  }
  const contactId = probeRes.contact?.id || probeRes.id
  if (!contactId) throw new Error('GHL did not return a contact id after upsert')

  // GHL's upsert response includes a `new` flag (sometimes nested,
  // sometimes top-level) indicating whether the contact was just
  // created. Only when truly new — and only if the caller provided
  // any name/company fields — do we PATCH the field values onto it.
  // If we can't tell from the response, default to NOT updating
  // (safer to leave a contact unnamed than to risk overwriting).
  const wasJustCreated =
    probeRes.new === true || probeRes.contact?.new === true
  const hasNameToSet =
    !!params.firstName ||
    !!params.lastName ||
    !!params.email ||
    !!params.companyName
  if (wasJustCreated && hasNameToSet) {
    const patchBody: Record<string, unknown> = {}
    if (params.firstName) patchBody.firstName = params.firstName
    if (params.lastName) patchBody.lastName = params.lastName
    if (params.email) patchBody.email = params.email
    if (params.companyName) patchBody.companyName = params.companyName
    try {
      await ghlFetch(`/contacts/${contactId}`, vaultEntryName, {
        method: 'PUT',
        body: JSON.stringify(patchBody),
      })
    } catch (err) {
      // Non-fatal — the contact exists and the SMS will still
      // deliver; the field-population is a nice-to-have for a
      // freshly-created contact. Logged so we can spot patterns
      // if a particular field shape keeps failing.
      console.warn(
        `[ghl] failed to set fields on newly-created contact ${contactId}:`,
        err,
      )
    }
  }
  return { id: contactId }
}

/**
 * Send an SMS to a phone number via GHL. Wraps upsertContactByPhone and
 * /conversations/messages (type=SMS). The conversationId is optional —
 * GHL auto-routes via the contact's default conversation when omitted.
 *
 * Returns the full GHL response so callers can surface messageId +
 * conversationId for diagnostics. A 200 from GHL only means "accepted"
 * — the SMS still has to clear carrier routing (A2P 10DLC, DND flags,
 * etc.), which happens asynchronously.
 */
export async function sendSmsToPhone(
  vaultEntryName: string,
  params: {
    phone: string
    message: string
    /** Used only when creating a NEW GHL contact (no existing
     *  contact at this phone). Existing contacts are never touched
     *  thanks to the find-first logic in upsertContactByPhone, so
     *  these can be safely passed without risk of overwriting
     *  someone else's CRM record. */
    firstName?: string
    lastName?: string
    /** GHL "Business name" — populated on new contact create. Pass
     *  the agency client's business name (Sunny Sky Solar, etc.) so
     *  the contact carries proper company metadata. Existing
     *  contacts are not modified. */
    companyName?: string
    /** E.164 sender number ("+16038034828"). When omitted, GHL routes
     *  via the location's default phone number — fine for prototypes,
     *  not so much when an agency runs multiple numbers (e.g. dedicated
     *  reminder line vs. agent outbound). The reminders dispatcher and
     *  morning brief sender both pass this from RemindersConfig.senderPhone. */
    fromNumber?: string
  }
): Promise<{
  contactId: string
  messageId?: string
  conversationId?: string
  normalizedPhone: string
  rawResponse: unknown
}> {
  const normalizedPhone = normalizePhone(params.phone)
  const fromNumber = params.fromNumber
    ? normalizePhone(params.fromNumber)
    : undefined
  const { id: contactId } = await upsertContactByPhone(vaultEntryName, {
    phone: normalizedPhone,
    firstName: params.firstName,
    lastName: params.lastName,
    companyName: params.companyName,
  })

  const res = (await ghlFetch('/conversations/messages', vaultEntryName, {
    method: 'POST',
    body: JSON.stringify({
      type: 'SMS',
      contactId,
      message: params.message,
      // Only include fromNumber when explicitly set — sending an empty
      // string trips GHL's validation; omitting it falls back to the
      // location default.
      ...(fromNumber ? { fromNumber } : {}),
    }),
  })) as {
    messageId?: string
    id?: string
    conversationId?: string
    status?: string
    [k: string]: unknown
  }

  console.log('[ghl] sendSmsToPhone response:', res)

  return {
    contactId,
    messageId: res.messageId || res.id,
    conversationId: res.conversationId,
    normalizedPhone,
    rawResponse: res,
  }
}

/**
 * Poll GHL for the latest status of a sent message. Useful right after
 * sendSmsToPhone to confirm whether the SMS actually went out (or got
 * queued, bounced, opted-out, etc.). GHL message status values include
 * 'pending', 'scheduled', 'sent', 'delivered', 'undelivered', 'failed',
 * 'read', 'unread'.
 */
export async function getMessageStatus(
  vaultEntryName: string,
  messageId: string
): Promise<{ status?: string; raw: unknown }> {
  const res = (await ghlFetch(
    `/conversations/messages/${messageId}`,
    vaultEntryName
  )) as { status?: string; messageStatus?: string; [k: string]: unknown }
  return { status: res.status || res.messageStatus, raw: res }
}
