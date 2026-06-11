import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { fetchVicidialListStats } from '@/lib/vicidial-lists'

/**
 * GET /api/admin/vicidial/lists/[id]
 *
 * Per-list called-count stats ("CALLED COUNTS WITHIN THIS LIST"):
 * status breakdown + grand total. Backs the /leads/[id] detail
 * header. Admin + member. Lib caches 5 minutes per list.
 *
 * PUT /api/admin/vicidial/lists/[id]  body: { clientId: string|null }
 *
 * Assign (or clear) the Hub client this dialer list belongs to.
 * Upserts the VicidialListLink row. Admin + member.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await ctx.params
  if (!/^\d+$/.test(id)) {
    return NextResponse.json({ error: 'invalid list id' }, { status: 400 })
  }

  const result = await fetchVicidialListStats(id)
  return NextResponse.json(result, {
    headers: { 'Cache-Control': 'no-store' },
  })
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await ctx.params
  if (!/^\d+$/.test(id)) {
    return NextResponse.json({ error: 'invalid list id' }, { status: 400 })
  }

  let body: { clientId?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  let clientId: string | null = null
  if (typeof body.clientId === 'string' && body.clientId.trim()) {
    const client = await prisma.client.findUnique({
      where: { id: body.clientId },
      select: { id: true },
    })
    if (!client) {
      return NextResponse.json({ error: 'unknown client' }, { status: 400 })
    }
    clientId = client.id
  } else if (body.clientId !== null && body.clientId !== undefined && body.clientId !== '') {
    return NextResponse.json(
      { error: 'clientId must be a client id string or null' },
      { status: 400 },
    )
  }

  const link = await prisma.vicidialListLink.upsert({
    where: { listId: id },
    create: { listId: id, clientId },
    update: { clientId },
    include: { client: { select: { id: true, name: true, color: true } } },
  })

  return NextResponse.json({
    ok: true,
    listId: id,
    linkedClientId: link.client?.id ?? null,
    linkedClientName: link.client?.name ?? null,
  })
}
