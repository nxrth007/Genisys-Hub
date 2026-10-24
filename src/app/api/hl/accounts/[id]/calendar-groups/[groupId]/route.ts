import { NextResponse } from 'next/server'
import { deleteGroup, updateGroup } from '@/lib/hl/calendar-records'
import { hlError, hlGuard, jsonBody } from '@/lib/hl/http'

type Ctx = { params: Promise<{ id: string; groupId: string }> }

/** PATCH { name?, description?, slug?, isActive? } */
export async function PATCH(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, groupId } = await params
  try {
    return NextResponse.json({ group: await updateGroup(id, groupId, await jsonBody(req)) })
  } catch (err) {
    return hlError(err, 'update calendar group')
  }
}

/** DELETE: the group goes; its calendars stay, ungrouped. */
export async function DELETE(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, groupId } = await params
  try {
    await deleteGroup(id, groupId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return hlError(err, 'delete calendar group')
  }
}
