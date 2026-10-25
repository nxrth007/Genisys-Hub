import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { calendar_v3 } from 'googleapis'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { updateAppointment } from './appointments'
import { fireStatusTrigger } from './booking'
import { calendarFor, forgetBusy, loadHlApp, noteError, syncAppointmentToGoogle, toConnection, type Row } from './google-calendar'
import { publicBase } from './twilio'

/**
 * Google → Hell-level, as GHL's Google Calendar does. Each connection watches
 * its calendars (Google's push notifications, renewed before their week runs
 * out) and reads just what changed since last time (sync tokens):
 *   - any change: that person's busy times are read again, so a new Google
 *     event blocks their slots straight away;
 *   - a booking's own event moved in Google: the appointment moves (as a
 *     staff reschedule does: its automations and notifications follow);
 *   - a booking's event deleted in Google: the appointment is cancelled.
 * (The last two are the connection's "pull" switch, on by default.) Only the
 * main host's copy speaks for an appointment. Google's notifications aren't
 * guaranteed, so every connection is also read every 10 minutes.
 */

const DAY = 86_400_000
/** Channels last a week (Google's default); a new one is opened a day before. */
const CHANNEL_MS = 7 * DAY
const RENEW_MS = DAY
const BACKSTOP_MS = 10 * 60_000
export const NOTIFY_PATH = '/api/hl/public/google-calendar/notify'

type Channel = { calendarId: string; id: string; resourceId: string; token: string; expiration: number }
type Data = Record<string, unknown> & { channels?: Channel[]; syncTokens?: Record<string, string> }

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {})
const asJson = (v: unknown) => v as Prisma.InputJsonValue

// Changes to one connection's record happen one at a time (channels, sync tokens and errors share it).
const queues = new Map<string, Promise<unknown>>()
function serial<T>(id: string, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(id) ?? Promise.resolve()).then(work)
  const tail = next.catch(() => undefined)
  queues.set(id, tail)
  void tail.then(() => {
    if (queues.get(id) === tail) queues.delete(id)
  })
  return next
}

async function loadRow(id: string): Promise<(Row & { accountId: string }) | null> {
  return prisma.hlRecord.findFirst({ where: { id, kind: 'calendar_connection' }, select: { id: true, name: true, data: true, accountId: true } })
}

async function patchData(id: string, change: (d: Data) => void): Promise<void> {
  const row = await prisma.hlRecord.findUnique({ where: { id }, select: { data: true } })
  if (!row) return
  const d = obj(row.data) as Data
  change(d)
  await prisma.hlRecord.update({ where: { id }, data: { data: asJson(d) } })
}

/**
 * The calendar a connection watches: the one its bookings go into, which they own. Their other
 * calendars may only be readable as free/busy (the permission asked for is calendar.events.owned),
 * so their busy times come from the few-minute busy cache instead.
 */
const watched = (row: Row) => [toConnection(row).calendarId]

const googleCode = (err: unknown) => Number((err as { code?: unknown }).code ?? (err as { response?: { status?: unknown } }).response?.status ?? 0)

// ---------------------------------------------------------------------------
// Watching
// ---------------------------------------------------------------------------

/** The sync token "from now on": paging through the calendar once (no changes are acted on). */
async function baseline(cal: calendar_v3.Calendar, calendarId: string): Promise<string | null> {
  let pageToken: string | undefined
  for (let page = 0; page < 40; page++) {
    const r = await cal.events.list({ calendarId, maxResults: 2500, showDeleted: true, pageToken, fields: 'nextPageToken,nextSyncToken' })
    if (r.data.nextSyncToken) return r.data.nextSyncToken
    pageToken = r.data.nextPageToken ?? undefined
    if (!pageToken) return null
  }
  return null
}

/**
 * Open (or renew) a connection's push channels and make sure each watched
 * calendar has a sync token. Channels for calendars no longer watched close.
 * A calendar Google won't watch (free/busy only) just relies on the backstop.
 */
export async function watchConnection(id: string): Promise<void> {
  await loadHlApp().catch(() => null)
  return serial(id, async () => {
    const row = await loadRow(id)
    if (!row) return
    const cal = calendarFor(row)
    if (!cal) return
    const d = obj(row.data) as Data
    const want = watched(row)
    const now = Date.now()
    const kept: Channel[] = []
    for (const ch of d.channels ?? []) {
      if (want.includes(ch.calendarId) && ch.expiration - now > RENEW_MS) kept.push(ch)
      else await cal.channels.stop({ requestBody: { id: ch.id, resourceId: ch.resourceId } }).catch(() => undefined)
    }
    const tokens = { ...(d.syncTokens ?? {}) }
    for (const calendarId of Object.keys(tokens)) if (!want.includes(calendarId)) delete tokens[calendarId]
    try {
      for (const calendarId of want) {
        tokens[calendarId] ??= (await baseline(cal, calendarId).catch(() => null)) ?? ''
        if (!tokens[calendarId]) delete tokens[calendarId]
        if (kept.some((ch) => ch.calendarId === calendarId)) continue
        // Google allows letters, digits and -_+/= in a channel id.
        const channel: Channel = { calendarId, id: `hl-${id}-${randomBytes(6).toString('hex')}`, resourceId: '', token: randomBytes(18).toString('base64url'), expiration: now + CHANNEL_MS }
        const r = await cal.events
          .watch({ calendarId, requestBody: { id: channel.id, type: 'web_hook', address: `${publicBase()}${NOTIFY_PATH}`, token: channel.token, expiration: String(channel.expiration) } })
          .catch((err) => {
            // Some calendars (free/busy only) can't be watched: the 10-minute read covers them.
            console.warn(`[hell-level] google watch ${row.name} ${calendarId}:`, err instanceof Error ? err.message : err)
            return null
          })
        if (r?.data.resourceId) kept.push({ ...channel, resourceId: r.data.resourceId, expiration: Number(r.data.expiration) || channel.expiration })
      }
    } catch (err) {
      await noteError(id, err)
    }
    await patchData(id, (x) => {
      x.channels = kept
      x.syncTokens = tokens
    })
  })
}

// ---------------------------------------------------------------------------
// What changed
// ---------------------------------------------------------------------------

const instant = (t: calendar_v3.Schema$EventDateTime | undefined) => (t?.dateTime ? new Date(t.dateTime).getTime() : null)

type GoogleRef = { eventId: string; calendarId: string; connectionId: string; email?: string; meet?: string }

/** A booking's event changed in Google: move or cancel the appointment, if it's the main host's copy and pull is on. */
async function applyChange(row: Row & { accountId: string }, e: calendar_v3.Schema$Event, appointmentId: string): Promise<string | null> {
  const c = toConnection(row)
  if (!c.pull || !e.id) return null
  const a = await prisma.hlAppointment.findFirst({ where: { id: appointmentId, accountId: row.accountId }, select: { id: true, accountId: true, startTime: true, endTime: true, status: true, meta: true, assignedUserId: true } })
  if (!a || a.status === 'cancelled' || a.status === 'invalid') return null
  const meta = obj(a.meta) as { google?: Record<string, GoogleRef>; members?: unknown }
  const refs = meta.google ?? {}
  const mine = Object.entries(refs).find(([, r]) => r.eventId === e.id && (r.connectionId === c.id || r.email === c.email))
  // Not a copy Hell-level is keeping (an old one, or one just being made): leave it.
  if (!mine) return null
  const members = Array.isArray(meta.members) ? meta.members.filter((m): m is string => typeof m === 'string') : []
  const host = a.assignedUserId ?? members[0]
  if (Object.keys(refs).length > 1 && host && mine[0] !== host) return null
  const by = `${c.email} in Google Calendar`
  if (e.status === 'cancelled') {
    // Its copy is gone already: forget it, then cancel (the other hosts' copies come off with it).
    const rest = { ...refs }
    delete rest[mine[0]]
    await prisma.hlAppointment.update({ where: { id: a.id }, data: { meta: asJson({ ...obj(a.meta), google: rest }) } })
    await updateAppointment(a.accountId, a.id, { status: 'cancelled' }, by)
    await fireStatusTrigger(a.id, 'cancelled')
    return 'cancelled'
  }
  const start = instant(e.start ?? undefined)
  const end = instant(e.end ?? undefined)
  // Made all-day, or nonsense: left as it is.
  if (start === null || end === null || end <= start) return null
  if (start === a.startTime.getTime() && end === a.endTime.getTime()) return null
  await updateAppointment(a.accountId, a.id, { start: new Date(start).toISOString(), end: new Date(end).toISOString(), ignoreAvailability: true }, by)
  await fireStatusTrigger(a.id, 'rescheduled')
  return 'moved'
}

/**
 * Read what changed on one watched calendar since its sync token, act on
 * bookings' events, and keep the new token. A token Google has dropped
 * (410) means starting again from now, after checking each upcoming booking.
 */
export async function syncCalendar(id: string, calendarId: string): Promise<{ changed: number; moved: number; cancelled: number }> {
  const out = { changed: 0, moved: 0, cancelled: 0 }
  await loadHlApp().catch(() => null)
  return serial(id, async () => {
    const row = await loadRow(id)
    if (!row) return out
    const cal = calendarFor(row)
    if (!cal) return out
    const d = obj(row.data) as Data
    const token = d.syncTokens?.[calendarId]
    if (!token) {
      // Never read yet (or reset): just the "from now on" point.
      const fresh = await baseline(cal, calendarId).catch(() => null)
      if (fresh)
        await patchData(id, (x) => {
          x.syncTokens = { ...(x.syncTokens ?? {}), [calendarId]: fresh }
        })
      return out
    }
    let pageToken: string | undefined
    let next: string | null = null
    const items: calendar_v3.Schema$Event[] = []
    try {
      for (let page = 0; page < 20; page++) {
        const r = await cal.events.list({ calendarId, syncToken: token, maxResults: 2500, pageToken })
        items.push(...(r.data.items ?? []))
        next = r.data.nextSyncToken ?? null
        pageToken = r.data.nextPageToken ?? undefined
        if (!pageToken) break
      }
    } catch (err) {
      if (googleCode(err) === 410) {
        // Google forgot where we were: start again from now, and check the bookings themselves.
        const fresh = await baseline(cal, calendarId).catch(() => null)
        await patchData(id, (x) => {
          const t = { ...(x.syncTokens ?? {}) }
          if (fresh) t[calendarId] = fresh
          else delete t[calendarId]
          x.syncTokens = t
        })
        forgetBusy(id)
        const r = await reconcile(row, cal)
        return { changed: 0, moved: r.moved, cancelled: r.cancelled }
      }
      await noteError(id, err)
      return out
    }
    out.changed = items.length
    if (items.length) forgetBusy(id)
    for (const e of items) {
      const appointmentId = e.extendedProperties?.private?.hlAppointmentId
      if (!appointmentId) continue
      const what = await applyChange(row, e, appointmentId).catch((err) => {
        console.error(`[hell-level] google change to ${appointmentId} failed:`, err)
        return null
      })
      if (what === 'moved') out.moved++
      if (what === 'cancelled') out.cancelled++
    }
    if (next) {
      const latest = next
      await patchData(id, (x) => {
        x.syncTokens = { ...(x.syncTokens ?? {}), [calendarId]: latest }
      })
    }
    return out
  })
}

/** Each upcoming booking with a copy on this connection, checked against Google one by one (after Google drops a sync token). */
async function reconcile(row: Row & { accountId: string }, cal: calendar_v3.Calendar): Promise<{ moved: number; cancelled: number }> {
  const out = { moved: 0, cancelled: 0 }
  const upcoming = await prisma.hlAppointment.findMany({
    where: { accountId: row.accountId, startTime: { gt: new Date(Date.now() - DAY) }, status: { notIn: ['cancelled', 'invalid'] }, source: { not: 'block' } },
    select: { id: true, meta: true },
    take: 500,
  })
  for (const a of upcoming) {
    const refs = (obj(a.meta).google ?? {}) as Record<string, GoogleRef>
    const ref = Object.values(refs).find((r) => r.connectionId === row.id)
    if (!ref) continue
    // Only an event Google says was deleted cancels: a 404 can also be a calendar removed or shared away.
    const e = await cal.events.get({ calendarId: ref.calendarId, eventId: ref.eventId }).then(
      (r) => r.data,
      () => null,
    )
    if (!e) continue
    const what = await applyChange(row, e, a.id).catch(() => null)
    if (what === 'moved') out.moved++
    if (what === 'cancelled') out.cancelled++
  }
  return out
}

// ---------------------------------------------------------------------------
// Google's notifications, the backstop, and a fresh connection
// ---------------------------------------------------------------------------

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * A push notification (headers only). Returns the work to do after
 * answering Google, or null for one that isn't ours or needs nothing.
 */
export async function handleGoogleNotification(h: { channelId: string | null; token: string | null; state: string | null }): Promise<(() => Promise<unknown>) | null> {
  const m = /^hl-([a-z0-9]+)-[0-9a-f]+$/.exec(h.channelId ?? '')
  if (!m || !h.token) return null
  const row = await loadRow(m[1])
  const ch = ((obj(row?.data) as Data).channels ?? []).find((x) => x.id === h.channelId)
  if (!row || !ch || !sameToken(ch.token, h.token)) return null
  // "sync" only says the channel is open.
  if (h.state === 'sync') return null
  return () => syncCalendar(row.id, ch.calendarId)
}

let lastBackstop = 0

/**
 * The scheduler's tick: every 10 minutes, every connection's watched
 * calendars are read for changes (Google's notifications can go missing)
 * and channels near the end of their week are renewed.
 */
export async function maybeSyncGoogleCalendars(): Promise<number> {
  if (Date.now() - lastBackstop < BACKSTOP_MS) return 0
  lastBackstop = Date.now()
  const rows = await prisma.hlRecord.findMany({ where: { kind: 'calendar_connection', account: { archivedAt: null } }, select: { id: true, name: true, data: true } })
  let changed = 0
  for (const row of rows) {
    const d = obj(row.data) as Data
    if (typeof d.error === 'string' && /invalid_grant/i.test(d.error)) continue
    const want = watched(row)
    const renew = want.some((cid) => !(d.channels ?? []).some((ch) => ch.calendarId === cid && ch.expiration - Date.now() > RENEW_MS))
    if (renew) await watchConnection(row.id).catch((err) => console.warn('[hell-level] google watch renew failed:', err))
    for (const cid of want) changed += (await syncCalendar(row.id, cid).catch(() => ({ changed: 0 }))).changed
  }
  return changed
}

/**
 * Just connected (or reconnected): start watching, then put their upcoming
 * appointments on the calendar (GHL's catch-up after a reconnect). Copies
 * already there are updated, not doubled.
 */
export async function afterGoogleConnect(id: string): Promise<number> {
  await watchConnection(id)
  const row = await loadRow(id)
  if (!row) return 0
  const c = toConnection(row)
  if (!c.push) return 0
  const keys = [...new Set([c.staffKey, c.staffId].filter(Boolean))]
  const upcoming = await prisma.hlAppointment.findMany({
    where: {
      accountId: row.accountId,
      startTime: { gt: new Date() },
      status: { notIn: ['cancelled', 'invalid'] },
      source: { not: 'block' },
      ghlId: null,
      OR: [{ assignedUserId: { in: keys } }, ...keys.map((k) => ({ meta: { path: ['members'], array_contains: [k] } }))],
    },
    select: { id: true },
    orderBy: { startTime: 'asc' },
    take: 300,
  })
  for (const a of upcoming) await syncAppointmentToGoogle(a.id)
  return upcoming.length
}
