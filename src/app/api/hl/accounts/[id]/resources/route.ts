import { NextResponse } from 'next/server'
import { hlAccountOr404, hlError, hlGuard, jsonBody } from '@/lib/hl/http'
import { createResource, listResources, type ResourceKind } from '@/lib/hl/resources'

type Ctx = { params: Promise<{ id: string }> }

const kindOf = (v: unknown): ResourceKind => (v === 'equipment' ? 'equipment' : 'room')

/** GET ?kind=room|equipment: the sub-account's rooms, or its equipment. */
export async function GET(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  return NextResponse.json({ resources: await listResources(id, kindOf(new URL(req.url).searchParams.get('kind'))) })
}

/** POST { kind, name, description?, quantity, outOfService?, calendarIds?, isActive? }: a new room or piece of equipment. */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  try {
    const body = await jsonBody(req)
    return NextResponse.json({ resource: await createResource(id, kindOf(body.kind), body) })
  } catch (err) {
    return hlError(err, 'create room or equipment')
  }
}
