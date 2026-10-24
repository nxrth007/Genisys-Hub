import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { hlError, hlGuard, jsonBody } from '@/lib/hl/http'
import { deleteResource, updateResource, type ResourceKind } from '@/lib/hl/resources'

type Ctx = { params: Promise<{ id: string; resourceId: string }> }

async function kindOf(accountId: string, id: string): Promise<ResourceKind | null> {
  const row = await prisma.hlRecord.findFirst({ where: { id, accountId, kind: { in: ['room', 'equipment'] } }, select: { kind: true } })
  return row ? (row.kind as ResourceKind) : null
}

/** PATCH { name?, description?, quantity?, outOfService?, calendarIds?, isActive? } */
export async function PATCH(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, resourceId } = await params
  const kind = await kindOf(id, resourceId)
  if (!kind) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    return NextResponse.json({ resource: await updateResource(id, kind, resourceId, await jsonBody(req)) })
  } catch (err) {
    return hlError(err, 'update room or equipment')
  }
}

/** DELETE: it stops being needed; bookings that took it keep their note of it. */
export async function DELETE(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, resourceId } = await params
  const kind = await kindOf(id, resourceId)
  if (!kind) return NextResponse.json({ ok: true })
  await deleteResource(id, kind, resourceId)
  return NextResponse.json({ ok: true })
}
