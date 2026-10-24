import { NextResponse, after } from 'next/server'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'
import { BookingError, book, fireBookingTriggers, publicCalendar, slotsFor } from '@/lib/hl/booking'

type Ctx = { params: Promise<{ calendarId: string }> }

/**
 * The public side of a booking calendar (the booking page, or a client's
 * own site). CORS * like the forms.
 *   GET ?from=ISO&to=ISO[&duration=minutes][&member=key]: the calendar and its open slots (62 days at most), with
 *   that team member free when one was picked.
 *   POST: a booking. Rate-limited per IP.
 */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS })
}

export async function GET(req: Request, { params }: Ctx) {
  const { calendarId } = await params
  const calendar = await publicCalendar(calendarId)
  if (!calendar) return NextResponse.json({ error: 'This calendar isn’t taking bookings.' }, { status: 404, headers: CORS })
  const sp = new URL(req.url).searchParams
  const from = sp.get('from') ? new Date(sp.get('from')!) : new Date()
  const to = sp.get('to') ? new Date(sp.get('to')!) : new Date(from.getTime() + 31 * 86_400_000)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) return NextResponse.json({ error: 'Bad date range.' }, { status: 400, headers: CORS })
  const capped = new Date(Math.min(to.getTime(), from.getTime() + 62 * 86_400_000))
  const duration = Number(sp.get('duration')) || undefined
  if (duration && !calendar.durations.includes(duration)) return NextResponse.json({ error: 'Pick one of the meeting lengths.' }, { status: 400, headers: CORS })
  try {
    const { slots } = await slotsFor(calendarId, from, capped, { duration })
    const member = sp.get('member')
    const open = member ? slots.filter((s) => s.members.includes(member)) : slots
    return NextResponse.json({ calendar, slots: open.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })) }, { headers: CORS })
  } catch (err) {
    if (err instanceof BookingError) return NextResponse.json({ error: err.message }, { status: 400, headers: CORS })
    console.error('[hell-level] slots failed:', err)
    return NextResponse.json({ error: 'Couldn’t load the times. Please try again.' }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request, { params }: Ctx) {
  const { calendarId } = await params
  const ip = clientIp(req)
  const limit = checkRateLimit(`hl-book:${ip ?? 'unknown'}`, 8, 10 * 60_000)
  if (!limit.ok) return NextResponse.json({ error: 'Too many bookings from here. Please try again in a few minutes.' }, { status: 429, headers: CORS })
  let raw: Record<string, unknown>
  try {
    raw = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Couldn’t read the booking.' }, { status: 400, headers: CORS })
  }
  // A filled honeypot means a bot.
  if (typeof raw._hp === 'string' && raw._hp) return NextResponse.json({ ok: true }, { headers: CORS })
  const s = (v: unknown) => (typeof v === 'string' ? v : null)
  try {
    const b = await book(calendarId, {
      start: s(raw.start) ?? '',
      duration: typeof raw.duration === 'number' || typeof raw.duration === 'string' ? raw.duration : null,
      firstName: s(raw.firstName),
      lastName: s(raw.lastName),
      phone: s(raw.phone),
      email: s(raw.email),
      notes: s(raw.notes),
      consent: raw.sms_consent === true || raw.sms_consent === 'true',
      marketingConsent: raw.marketing_consent === true || raw.marketing_consent === 'true',
      timezone: s(raw.timezone),
      pageUrl: s(raw._page) ?? req.headers.get('referer'),
      member: s(raw.member),
    })
    after(() => fireBookingTriggers(b).catch((err) => console.error('[hell-level] booking automations failed:', err)))
    const calendar = await publicCalendar(calendarId)
    return NextResponse.json(
      {
        ok: true,
        start: b.start.toISOString(),
        end: b.end.toISOString(),
        manageUrl: b.manageUrl,
        thankYou: calendar?.thankYou ?? null,
        redirectUrl: calendar?.redirectUrl ?? null,
        series: b.series.map((x) => ({ start: x.start.toISOString(), end: x.end.toISOString() })),
      },
      { headers: CORS },
    )
  } catch (err) {
    if (err instanceof BookingError) return NextResponse.json({ error: err.message, field: err.field }, { status: 400, headers: CORS })
    console.error('[hell-level] booking failed:', err)
    return NextResponse.json({ error: 'Something went wrong. Please call us to book.' }, { status: 500, headers: CORS })
  }
}
