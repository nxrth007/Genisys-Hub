import { NextResponse } from 'next/server'
import { hlAccountOr404, hlError, hlGuard, jsonBody } from '@/lib/hl/http'
import { createMenu, listMenus } from '@/lib/hl/service-menus'
import { publicBase } from '@/lib/hl/twilio'

type Ctx = { params: Promise<{ id: string }> }

/** GET: the sub-account's service menus, with where their pages are. */
export async function GET(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  return NextResponse.json({ menus: await listMenus(id), base: `${publicBase()}/hl/m/` })
}

/** POST { name, description?, calendarIds?, staffSelection?, isActive? }: a new service menu. */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  try {
    return NextResponse.json({ menu: await createMenu(id, await jsonBody(req)) })
  } catch (err) {
    return hlError(err, 'create service menu')
  }
}
