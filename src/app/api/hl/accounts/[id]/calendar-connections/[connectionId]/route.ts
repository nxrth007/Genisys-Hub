import { NextResponse, after } from 'next/server'
import { googleCalendars, removeConnection, updateConnection } from '@/lib/hl/google-calendar'
import { watchConnection } from '@/lib/hl/google-sync'
import { hlError, hlGuard, jsonBody } from '@/lib/hl/http'

type Ctx = { params: Promise<{ id: string; connectionId: string }> }

/** GET: its Google calendars, to choose from. */
export async function GET(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, connectionId } = await params
  try {
    return NextResponse.json({ calendars: await googleCalendars(id, connectionId) })
  } catch (err) {
    return hlError(err, 'list Google calendars')
  }
}

/**
 * PATCH { conflicts?, push?, pull?, calendarId?, checkIds? }: whether busy
 * times block slots and which calendars count; whether bookings are written
 * into Google and which calendar they go into; whether moves and deletions
 * made in Google change the appointment. The calendars watched for live
 * changes follow.
 */
export async function PATCH(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, connectionId } = await params
  try {
    const connection = await updateConnection(id, connectionId, await jsonBody(req))
    after(() => watchConnection(connectionId).catch((err) => console.error('[hell-level] google watch failed:', err)))
    return NextResponse.json({ connection })
  } catch (err) {
    return hlError(err, 'update calendar connection')
  }
}

/** DELETE: disconnect (Google forgets the sign-in; events already in Google stay). */
export async function DELETE(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, connectionId } = await params
  try {
    await removeConnection(id, connectionId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return hlError(err, 'disconnect calendar')
  }
}
