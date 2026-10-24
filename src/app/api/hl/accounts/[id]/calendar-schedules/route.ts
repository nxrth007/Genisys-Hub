import { NextResponse } from 'next/server'
import { listSchedules, saveSchedule } from '@/lib/hl/calendar-records'
import { hlAccountOr404, hlError, hlGuard, jsonBody } from '@/lib/hl/http'

type Ctx = { params: Promise<{ id: string }> }

/** GET: every team member's schedules (Settings → Calendars → Availability). */
export async function GET(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  return NextResponse.json({ schedules: await listSchedules(id) })
}

/** POST { userId, name, timezone, openHours?, availabilities?, calendarIds? }: a new schedule. */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  try {
    return NextResponse.json({ schedule: await saveSchedule(id, await jsonBody(req)) })
  } catch (err) {
    return hlError(err, 'create schedule')
  }
}
