import { NextResponse } from 'next/server'
import { hlError, hlGuard, jsonBody } from '@/lib/hl/http'
import { deleteMenu, updateMenu } from '@/lib/hl/service-menus'

type Ctx = { params: Promise<{ id: string; menuId: string }> }

/** PATCH { name?, description?, calendarIds?, staffSelection?, isActive? } */
export async function PATCH(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, menuId } = await params
  try {
    return NextResponse.json({ menu: await updateMenu(id, menuId, await jsonBody(req)) })
  } catch (err) {
    return hlError(err, 'update service menu')
  }
}

/** DELETE: the menu's page goes; its calendars stay. */
export async function DELETE(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, menuId } = await params
  await deleteMenu(id, menuId)
  return NextResponse.json({ ok: true })
}
