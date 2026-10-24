import { NextResponse, after } from 'next/server'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'
import { BookingError, appointmentByToken, cancelByToken, fireStatusTrigger, rescheduleByToken } from '@/lib/hl/booking'

type Ctx = { params: Promise<{ token: string }> }

/**
 * The reschedule / cancel link a booking texts out (/hl/a/<token>). The
 * token is the access: long, random, one per appointment.
 *   GET: the appointment.
 *   POST { action: 'reschedule', start } | { action: 'cancel' }
 */
export async function GET(_req: Request, { params }: Ctx) {
  const { token } = await params
  const a = await appointmentByToken(token)
  if (!a) return NextResponse.json({ error: 'This appointment can’t be found.' }, { status: 404 })
  return NextResponse.json({ appointment: a })
}

export async function POST(req: Request, { params }: Ctx) {
  const { token } = await params
  const limit = checkRateLimit(`hl-manage:${clientIp(req) ?? 'unknown'}`, 20, 10 * 60_000)
  if (!limit.ok) return NextResponse.json({ error: 'Too many changes from here. Please try again in a few minutes.' }, { status: 429 })
  let body: Record<string, unknown> = {}
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    // empty body: rejected below
  }
  try {
    if (body.action === 'reschedule') {
      const r = await rescheduleByToken(token, typeof body.start === 'string' ? body.start : '')
      after(() => fireStatusTrigger(r.appointmentId, 'rescheduled').catch((err) => console.error('[hell-level] reschedule automations failed:', err)))
      return NextResponse.json({ ok: true, start: r.start.toISOString(), end: r.end.toISOString() })
    }
    if (body.action === 'cancel') {
      const r = await cancelByToken(token)
      after(() => fireStatusTrigger(r.appointmentId, 'cancelled').catch((err) => console.error('[hell-level] cancel automations failed:', err)))
      return NextResponse.json({ ok: true })
    }
    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })
  } catch (err) {
    if (err instanceof BookingError) return NextResponse.json({ error: err.message, field: err.field }, { status: 400 })
    console.error('[hell-level] appointment change failed:', err)
    return NextResponse.json({ error: 'Something went wrong. Please call us.' }, { status: 500 })
  }
}
