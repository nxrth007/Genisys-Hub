import { NextResponse } from 'next/server'
import { createGroup, listGroups } from '@/lib/hl/calendar-records'
import { hlAccountOr404, hlError, hlGuard, jsonBody } from '@/lib/hl/http'

type Ctx = { params: Promise<{ id: string }> }

/** GET: the sub-account's calendar groups. */
export async function GET(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  return NextResponse.json({ groups: await listGroups(id) })
}

/** POST { name, description?, slug? }: a new group. */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  try {
    return NextResponse.json({ group: await createGroup(id, await jsonBody(req)) })
  } catch (err) {
    return hlError(err, 'create calendar group')
  }
}
