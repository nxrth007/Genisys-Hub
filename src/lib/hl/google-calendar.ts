import { createHmac, timingSafeEqual } from 'node:crypto'
import { google, type calendar_v3 } from 'googleapis'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { decryptSecret, encryptSecret } from '@/lib/crypto'
import { getOAuth2Client } from '@/lib/drive'
import { loadAppointment, mergeFor } from './calendar-notify'
import { asCalendarSettings, wantsMeet } from './calendar-shared'
import { HlInputError } from './http'
import { renderTemplate } from './merge'
import type { Busy } from './slots'
import { publicBase } from './twilio'

/**
 * Google Calendar for Hell-level team members (GHL's Connections →
 * Calendars → Google, and Video conferencing → Google Meet). A team member
 * connects their own Google account; then
 *   - busy times on their Google Calendar block their slots (events
 *     Hell-level put there itself don't count twice), and
 *   - their appointments are written into it, moved when they move, and
 *     removed when cancelled, with a Google Meet link when the calendar (or
 *     the member's GHL settings) says Meet.
 * The sign-in shares the Hub's Google client and its registered return
 * address (/api/drive/callback), told apart by a signed state; the refresh
 * token is kept encrypted like a Vault secret, on an HlRecord of kind
 * calendar_connection. Appointments imported from GHL are left to GHL's own
 * sync, which already put them in Google.
 */

export const GOOGLE_CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/userinfo.email']
const STATE_PREFIX = 'hl-cal.'
const STATE_TTL = 60 * 60_000
const SHARE_TTL = 7 * 86_400_000
const BUSY_TTL = 3 * 60_000
const CLIENT_TTL = 45 * 60_000
/** A busy-time read that takes longer is given up on (a booking waits on it). */
const GOOGLE_TIMEOUT = 6000
const DAY = 86_400_000

type Db = typeof prisma | Prisma.TransactionClient
const asJson = (v: unknown) => v as Prisma.InputJsonValue
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {})

// ---------------------------------------------------------------------------
// Signed links
// ---------------------------------------------------------------------------

const secret = () => process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || 'hell-level-calendar'
const sign = (body: string) => createHmac('sha256', secret()).update(`hl-cal:${body}`).digest('base64url').slice(0, 22)

function verify(body: string | undefined, sig: string | undefined, salt: string): Record<string, unknown> | null {
  if (!body || !sig) return null
  const want = Buffer.from(sign(`${salt}${body}`))
  const got = Buffer.from(sig)
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  try {
    return obj(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')))
  } catch {
    return null
  }
}

export type ConnectState = { accountId: string; staffKey: string; back: 'hub' | 'page' }

/** A signed, hour-long state for Google's sign-in: which sub-account, which team member, where to come back to. */
export function connectState(s: ConnectState): string {
  const body = Buffer.from(JSON.stringify({ a: s.accountId, s: s.staffKey, b: s.back, t: Date.now() })).toString('base64url')
  return `${STATE_PREFIX}${body}.${sign(body)}`
}

export const isCalendarState = (state: string | null | undefined): state is string => !!state && state.startsWith(STATE_PREFIX)

export function readConnectState(state: string | null | undefined): ConnectState | null {
  if (!isCalendarState(state)) return null
  const [body, sig] = state.slice(STATE_PREFIX.length).split('.')
  const d = verify(body, sig, '')
  if (!d || typeof d.a !== 'string' || typeof d.s !== 'string' || typeof d.t !== 'number' || Date.now() - d.t > STATE_TTL) return null
  return { accountId: d.a, staffKey: d.s, back: d.b === 'page' ? 'page' : 'hub' }
}

/** Google's consent screen for the calendar scopes. `origin` must be the host the sign-in comes back to. */
export function googleConsentUrl(origin: string, s: ConnectState): string {
  return getOAuth2Client(origin).generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: GOOGLE_CALENDAR_SCOPES, state: connectState(s) })
}

/** A week-long link to send a team member (a client's staff), so they connect their own Google Calendar without a Hub login. */
export function shareableConnectLink(accountId: string, staffKey: string): string {
  const body = Buffer.from(JSON.stringify({ a: accountId, s: staffKey, t: Date.now() })).toString('base64url')
  return `${publicBase()}/hl/connect/${body}.${sign(`share:${body}`)}`
}

export function readShareToken(token: string): { accountId: string; staffKey: string } | null {
  const [body, sig] = token.split('.')
  const d = verify(body, sig, 'share:')
  if (!d || typeof d.a !== 'string' || typeof d.s !== 'string' || typeof d.t !== 'number' || Date.now() - d.t > SHARE_TTL) return null
  return { accountId: d.a, staffKey: d.s }
}

/** Who a connect link is for: the team member and their business (null: they're gone, or the sub-account is). */
export async function connectTarget(accountId: string, staffKey: string) {
  const [account, staff] = await Promise.all([
    prisma.hlAccount.findUnique({ where: { id: accountId }, select: { name: true, archivedAt: true, profile: true } }),
    staffRecord(accountId, staffKey),
  ])
  if (!account || account.archivedAt || !staff) return null
  const profile = obj(account.profile)
  return { business: (typeof profile.businessName === 'string' && profile.businessName.trim()) || account.name, member: staff.name }
}

const staffRecord = (accountId: string, key: string) =>
  prisma.hlRecord.findFirst({ where: { accountId, kind: 'user', OR: [{ id: key }, { ghlId: key }] }, select: { id: true, ghlId: true, name: true } })

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export type CalendarConnection = {
  id: string
  provider: 'google'
  /** The team member: a calendar's teamMembers[].userId (their GHL id, else their staff record's id). */
  staffKey: string
  staffId: string
  email: string
  /** The Google calendar bookings go into (GHL's linked calendar). */
  calendarId: string
  /** The Google calendars whose busy times count (GHL's conflict calendars). */
  checkIds: string[]
  /** Busy times block this person's slots. */
  conflicts: boolean
  /** Bookings are written into it. */
  push: boolean
  connectedAt: string
  error: string | null
}

type Row = { id: string; name: string; data: unknown }

const ids = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && !!x && x.length <= 300))].slice(0, 20) : null)

function toConnection(r: Row): CalendarConnection {
  const d = obj(r.data)
  const calendarId = typeof d.calendarId === 'string' && d.calendarId ? d.calendarId : 'primary'
  return {
    id: r.id,
    provider: 'google',
    staffKey: String(d.staffKey ?? ''),
    staffId: String(d.staffId ?? d.staffKey ?? ''),
    email: r.name,
    calendarId,
    checkIds: ids(d.checkIds) ?? [calendarId],
    conflicts: d.conflicts !== false,
    push: d.push !== false,
    connectedAt: String(d.connectedAt ?? ''),
    error: typeof d.error === 'string' ? d.error : null,
  }
}

const isFor = (c: CalendarConnection, key: string) => c.staffKey === key || c.staffId === key

const rowsOf = (accountId: string, db: Db = prisma): Promise<Row[]> =>
  db.hlRecord.findMany({ where: { accountId, kind: 'calendar_connection' }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true, data: true } })

export async function listConnections(accountId: string, db: Db = prisma): Promise<CalendarConnection[]> {
  return (await rowsOf(accountId, db)).map(toConnection)
}

/** Finish Google's sign-in: keep the refresh token (encrypted) for the team member, replacing their earlier connection. */
export async function finishGoogleConnect(code: string, origin: string, s: ConnectState): Promise<{ email: string }> {
  const staff = await staffRecord(s.accountId, s.staffKey)
  if (!staff) throw new HlInputError('That team member isn’t on the sub-account any more.')
  const client = getOAuth2Client(origin)
  const { tokens } = await client.getToken(code)
  const granted = (tokens.scope ?? '').split(/\s+/)
  if (!GOOGLE_CALENDAR_SCOPES.slice(0, 2).every((x) => granted.includes(x))) throw new HlInputError('Google didn’t give calendar access. Connect again and leave the calendar boxes ticked on Google’s screen.')
  if (!tokens.refresh_token) throw new HlInputError('Google didn’t give a lasting sign-in. Remove Genisys from the Google account’s third-party access, then connect again.')
  client.setCredentials(tokens)
  const { data } = await google.oauth2({ version: 'v2', auth: client }).userinfo.get()
  const email = data.email
  if (!email) throw new HlInputError('Google didn’t say which account this is.')
  const enc = encryptSecret(tokens.refresh_token)
  const record = {
    provider: 'google',
    staffKey: staff.ghlId ?? staff.id,
    staffId: staff.id,
    refresh: Buffer.from(enc.ciphertext).toString('base64'),
    nonce: Buffer.from(enc.nonce).toString('base64'),
    calendarId: 'primary',
    conflicts: true,
    push: true,
    connectedAt: new Date().toISOString(),
  }
  await prisma.$transaction(async (tx) => {
    const theirs = (await listConnections(s.accountId, tx)).filter((c) => c.staffId === staff.id || isFor(c, s.staffKey))
    if (theirs.length) await tx.hlRecord.deleteMany({ where: { id: { in: theirs.map((c) => c.id) } } })
    await tx.hlRecord.create({ data: { accountId: s.accountId, kind: 'calendar_connection', name: email, data: asJson(record) } })
  })
  forget()
  return { email }
}

export async function updateConnection(accountId: string, id: string, patch: { conflicts?: unknown; push?: unknown; calendarId?: unknown; checkIds?: unknown }): Promise<CalendarConnection> {
  const row = await prisma.hlRecord.findFirst({ where: { id, accountId, kind: 'calendar_connection' } })
  if (!row) throw new HlInputError('Connection not found.')
  const d = obj(row.data)
  if (typeof patch.conflicts === 'boolean') d.conflicts = patch.conflicts
  if (typeof patch.push === 'boolean') d.push = patch.push
  if (patch.calendarId !== undefined) {
    if (typeof patch.calendarId !== 'string' || !patch.calendarId || patch.calendarId.length > 300) throw new HlInputError('Pick the calendar bookings go into.')
    d.calendarId = patch.calendarId
  }
  if (patch.checkIds !== undefined) {
    const list = ids(patch.checkIds)
    if (!list) throw new HlInputError('The calendars to check must be a list.')
    d.checkIds = list
  }
  forget()
  return toConnection(await prisma.hlRecord.update({ where: { id }, data: { data: asJson(d) } }))
}

/** Disconnect: Google is told to forget the sign-in too (best effort). Events already put in Google stay there. */
export async function removeConnection(accountId: string, id: string): Promise<void> {
  const row = await prisma.hlRecord.findFirst({ where: { id, accountId, kind: 'calendar_connection' } })
  if (!row) return
  const token = refreshOf(row)
  if (token) await getOAuth2Client().revokeToken(token).catch(() => undefined)
  await prisma.hlRecord.delete({ where: { id } })
  forget()
}

function refreshOf(row: { data: unknown }): string | null {
  const d = obj(row.data)
  if (typeof d.refresh !== 'string' || typeof d.nonce !== 'string') return null
  try {
    return decryptSecret(Buffer.from(d.refresh, 'base64'), Buffer.from(d.nonce, 'base64'))
  } catch {
    return null
  }
}

// One Google client per connection for a while (it keeps its access token and renews it itself).
const clients = new Map<string, { at: number; cal: calendar_v3.Calendar }>()
const busyCache = new Map<string, { at: number; busy: { start: number; end: number }[] }>()
function forget() {
  clients.clear()
  busyCache.clear()
}

/** A connection's Google client, from its row (no database read: a booking asks for busy times inside its transaction). */
function calendarFor(row: Row | undefined): calendar_v3.Calendar | null {
  if (!row) return null
  const hit = clients.get(row.id)
  if (hit && Date.now() - hit.at < CLIENT_TTL) return hit.cal
  const token = refreshOf(row)
  if (!token) return null
  const auth = getOAuth2Client()
  auth.setCredentials({ refresh_token: token })
  const cal = google.calendar({ version: 'v3', auth })
  clients.set(row.id, { at: Date.now(), cal })
  return cal
}

/** Google's words for a failure, kept on the connection for the Connections page (a revoked sign-in says invalid_grant). */
async function noteError(id: string, err: unknown, db: Db = prisma): Promise<void> {
  const g = err as { message?: string; response?: { data?: { error?: unknown; error_description?: unknown } } }
  const data = g.response?.data
  const message = typeof data?.error_description === 'string' ? data.error_description : typeof data?.error === 'string' ? data.error : (g.message ?? String(err))
  clients.delete(id)
  const row = await db.hlRecord.findUnique({ where: { id }, select: { data: true } })
  if (!row) return
  await db.hlRecord.update({ where: { id }, data: { data: asJson({ ...obj(row.data), error: message.slice(0, 300), errorAt: new Date().toISOString() }) } })
}

async function clearError(c: CalendarConnection, db: Db = prisma): Promise<void> {
  if (!c.error) return
  const row = await db.hlRecord.findUnique({ where: { id: c.id }, select: { data: true } })
  if (!row) return
  const d = obj(row.data)
  delete d.error
  delete d.errorAt
  await db.hlRecord.update({ where: { id: c.id }, data: { data: asJson(d) } })
}

// ---------------------------------------------------------------------------
// Busy times
// ---------------------------------------------------------------------------

/** The Google calendars on a connection: to pick where bookings go and which count as busy. */
export async function googleCalendars(accountId: string, id: string): Promise<{ id: string; name: string; primary: boolean; canWrite: boolean }[]> {
  const row = await prisma.hlRecord.findFirst({ where: { id, accountId, kind: 'calendar_connection' }, select: { id: true, name: true, data: true } })
  if (!row) throw new HlInputError('Connection not found.')
  const cal = calendarFor(row)
  if (!cal) throw new HlInputError('This connection’s Google sign-in can’t be read. Connect again.')
  try {
    const r = await cal.calendarList.list({ minAccessRole: 'freeBusyReader', maxResults: 250 })
    return (r.data.items ?? [])
      .filter((x) => x.id && !x.deleted)
      .map((x) => ({ id: x.primary ? 'primary' : x.id!, name: x.summaryOverride || x.summary || x.id!, primary: !!x.primary, canWrite: x.accessRole === 'owner' || x.accessRole === 'writer' }))
      .sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name))
  } catch (err) {
    await noteError(id, err)
    throw new HlInputError(`Google wouldn’t list the calendars: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * The busy times on a connection's calendars: the one bookings go into is
 * read event by event (so Hell-level's own appointments are left out);
 * any other calendar is asked for its free/busy only.
 */
async function busyOf(row: Row, c: CalendarConnection, lo: number, hi: number, db: Db): Promise<{ start: number; end: number }[] | null> {
  const key = `${c.id}|${lo}|${hi}`
  const hit = busyCache.get(key)
  if (hit && Date.now() - hit.at < BUSY_TTL) return hit.busy
  try {
    const cal = calendarFor(row)
    if (!cal) return null
    const busy: { start: number; end: number }[] = []
    const timeMin = new Date(lo).toISOString()
    const timeMax = new Date(hi).toISOString()
    if (c.checkIds.includes(c.calendarId)) {
      let pageToken: string | undefined
      for (let page = 0; page < 10; page++) {
        const r = await cal.events.list({ calendarId: c.calendarId, timeMin, timeMax, singleEvents: true, maxResults: 2500, pageToken }, { timeout: GOOGLE_TIMEOUT })
        for (const e of r.data.items ?? []) {
          // Free time, declined invitations and Hell-level's own appointments (already counted) don't block.
          if (e.status === 'cancelled' || e.transparency === 'transparent') continue
          if (e.extendedProperties?.private?.hlAppointmentId) continue
          if (e.attendees?.some((x) => x.self && x.responseStatus === 'declined')) continue
          const s = e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00Z` : null)
          const en = e.end?.dateTime ?? (e.end?.date ? `${e.end.date}T00:00:00Z` : null)
          if (s && en) busy.push({ start: new Date(s).getTime(), end: new Date(en).getTime() })
        }
        pageToken = r.data.nextPageToken ?? undefined
        if (!pageToken) break
      }
    }
    const others = c.checkIds.filter((x) => x !== c.calendarId)
    if (others.length) {
      const r = await cal.freebusy.query({ requestBody: { timeMin, timeMax, items: others.map((id) => ({ id })) } }, { timeout: GOOGLE_TIMEOUT })
      for (const v of Object.values(r.data.calendars ?? {})) {
        for (const b of v.busy ?? []) if (b.start && b.end) busy.push({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() })
      }
    }
    if (busyCache.size > 500) busyCache.clear()
    busyCache.set(key, { at: Date.now(), busy })
    await clearError(c, db)
    return busy
  } catch (err) {
    console.warn(`[hell-level] google calendar ${c.email}:`, err instanceof Error ? err.message : err)
    await noteError(c.id, err, db)
    return null
  }
}

/**
 * Busy times on the team members' Google Calendars between two instants,
 * as the slot engine's Busy (no calendar: it's outside Hell-level). A
 * calendar Google won't read for now just doesn't block anything.
 */
export async function googleBusy(accountId: string, members: string[], from: Date, to: Date, db: Db = prisma): Promise<Busy[]> {
  if (!members.length) return []
  const conns = (await rowsOf(accountId, db)).map((row) => ({ row, c: toConnection(row) })).filter(({ c }) => c.conflicts && c.checkIds.length && members.some((k) => isFor(c, k)))
  if (!conns.length) return []
  // Whole days, cached a few minutes: the booking page asks a lot.
  const lo = Math.floor(from.getTime() / DAY) * DAY
  const hi = Math.ceil(to.getTime() / DAY) * DAY
  const lists = await Promise.all(conns.map(({ row, c }) => busyOf(row, c, lo, hi, db)))
  return conns.flatMap(({ c }, i) => {
    const member = members.find((k) => isFor(c, k))!
    return (lists[i] ?? []).filter((b) => b.end > from.getTime() && b.start < to.getTime()).map((b) => ({ start: new Date(b.start), end: new Date(b.end), member, calendarId: null }))
  })
}

// ---------------------------------------------------------------------------
// Appointments into Google
// ---------------------------------------------------------------------------

/** Where a member's copy of an appointment is in Google (meta.google, by member). */
type GoogleRef = { eventId: string; calendarId: string; connectionId: string; email?: string; meet?: string }

const DEFAULT_NOTES = 'Booked with {{account.business_name}}.\nPhone: {{contact.phone}}\nEmail: {{contact.email}}\nReschedule or cancel: {{appointment.reschedule_link}}'
const MEET = /^google meet$/i

/**
 * Put an appointment on its team members' Google Calendars (or move it, or
 * take it off when it's cancelled or no longer theirs). The first Meet link
 * becomes the appointment's location when it has none of its own, so the
 * confirmation texts carry it: run this before the booked notifications.
 * Never throws.
 */
export async function syncAppointmentToGoogle(appointmentId: string): Promise<void> {
  try {
    const a = await loadAppointment(appointmentId)
    if (!a || a.source === 'block' || a.ghlId) return
    const meta = obj(a.meta) as { members?: unknown; google?: Record<string, GoogleRef> }
    const members = Array.isArray(meta.members) && meta.members.length ? meta.members.filter((m): m is string => typeof m === 'string') : a.assignedUserId ? [a.assignedUserId] : []
    const rows = await rowsOf(a.accountId)
    const all = rows.map(toConnection)
    const calOf = (id: string) => calendarFor(rows.find((r) => r.id === id))
    const refs: Record<string, GoogleRef> = { ...(meta.google ?? {}) }
    const targets = members.flatMap((k) => {
      const c = all.find((x) => x.push && isFor(x, k))
      return c ? [{ key: k, c }] : []
    })
    if (!targets.length && !Object.keys(refs).length) return
    const before = JSON.stringify(refs)

    // A member taken off it: their copy comes off their calendar. A copy on a calendar since disconnected is forgotten
    // (a reconnect of the same Google account picks its copy up again by the email).
    const connOf = (key: string, ref: GoogleRef) => all.find((x) => x.id === ref.connectionId || (!!ref.email && x.email === ref.email && isFor(x, key)))
    const dropped: string[] = []
    for (const key of Object.keys(refs)) {
      const ref = refs[key]
      const conn = connOf(key, ref)
      if (conn && members.includes(key)) continue
      if (conn) {
        const cal = calOf(conn.id)
        if (cal) await cal.events.delete({ calendarId: ref.calendarId, eventId: ref.eventId }).catch(() => undefined)
      }
      if (ref.meet) dropped.push(ref.meet)
      delete refs[key]
    }

    const settings = asCalendarSettings(a.calendar?.settings)
    const live = a.status !== 'cancelled' && a.status !== 'invalid'
    const description = renderTemplate(settings.notes?.trim() || DEFAULT_NOTES, mergeFor(a))
    const where = a.address && !MEET.test(a.address) && !/meet\.google\.com/.test(a.address) ? a.address : undefined
    let meetLink: string | null = null
    for (const { key, c } of targets) {
      const ref = refs[key]
      try {
        const cal = calOf(c.id)
        if (!cal) continue
        if (!live) {
          if (ref) await cal.events.delete({ calendarId: ref.calendarId, eventId: ref.eventId }).catch(() => undefined)
          delete refs[key]
          continue
        }
        // One Meet per meeting: the first host's. Other hosts (a collective calendar) get its link as the location.
        const meet = wantsMeet(settings, key) && !ref?.meet && !meetLink
        const body: calendar_v3.Schema$Event = {
          summary: a.title,
          description,
          location: where ?? (meetLink && !ref?.meet ? meetLink : undefined),
          start: { dateTime: a.startTime.toISOString(), timeZone: a.account.timezone },
          end: { dateTime: a.endTime.toISOString(), timeZone: a.account.timezone },
          extendedProperties: { private: { hlAppointmentId: a.id } },
          ...(meet ? { conferenceData: { createRequest: { requestId: `hl-${a.id}-${c.id}`.slice(0, 64), conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : {}),
        }
        // Their copy is on this Google account already (a reconnect included): change it; else make one.
        const same = !!ref && (ref.connectionId === c.id || ref.email === c.email)
        const r = same
          ? await cal.events.patch({ calendarId: ref.calendarId, eventId: ref.eventId, conferenceDataVersion: 1, requestBody: body })
          : await cal.events.insert({ calendarId: c.calendarId, conferenceDataVersion: 1, requestBody: body })
        const link = r.data.hangoutLink ?? ref?.meet ?? undefined
        if (r.data.id) refs[key] = { eventId: r.data.id, calendarId: same ? ref.calendarId : c.calendarId, connectionId: c.id, email: c.email, ...(link ? { meet: link } : {}) }
        meetLink ??= link ?? null
        await clearError(c)
      } catch (err) {
        console.warn(`[hell-level] google calendar push ${c.email}:`, err instanceof Error ? err.message : err)
        await noteError(c.id, err)
        // A copy Google says is gone is made again next time.
        const code = (err as { code?: number }).code
        if (code === 404 || code === 410) delete refs[key]
      }
    }

    if (JSON.stringify(refs) === before && (!meetLink || meetLink === a.address)) return
    const fresh = await prisma.hlAppointment.findUnique({ where: { id: a.id }, select: { meta: true, address: true } })
    if (!fresh) return
    // The Meet link is where the meeting is, unless the appointment says somewhere real. A link from a host taken
    // off it goes: the new host's link, else the calendar's own location.
    const ours = !fresh.address || MEET.test(fresh.address) || dropped.includes(fresh.address)
    const address = !live || !ours ? undefined : (meetLink ?? (fresh.address && dropped.includes(fresh.address) ? settings.meetingLocation?.trim() || null : undefined))
    await prisma.hlAppointment.update({
      where: { id: a.id },
      data: { meta: asJson({ ...obj(fresh.meta), google: refs }), ...(address !== undefined && address !== fresh.address ? { address } : {}) },
    })
  } catch (err) {
    console.error('[hell-level] google calendar sync failed:', err)
  }
}
