import { NextResponse } from 'next/server'
import { deleteSchedule, saveSchedule } from '@/lib/hl/calendar-records'
import { hlError, hlGuard, jsonBody } from '@/lib/hl/http'

type Ctx = { params: Promise<{ id: string; scheduleId: string }> }

/** PATCH { name?, timezone?, openHours?, availabilities?, calendarIds? } */
export async function PATCH(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, scheduleId } = await params
  try {
    return NextResponse.json({ schedule: await saveSchedule(id, await jsonBody(req), scheduleId) })
  } catch (err) {
    return hlError(err, 'update schedule')
  }
}

/** DELETE: the calendars it was on go back to their own hours for that member. */
export async function DELETE(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, scheduleId } = await params
  try {
    await deleteSchedule(id, scheduleId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return hlError(err, 'delete schedule')
  }
}
