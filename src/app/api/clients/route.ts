import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET  /api/clients
 *   Returns the active client list (Brighton Capital Solar, Spring Solar, …).
 *   Used by both the agent appointment form and staff filters. Reachable
 *   by any signed-in user (agents need it to populate their picker).
 *
 * POST /api/clients
 *   Creates a new client. Admin-only — middleware doesn't gate by HTTP
 *   method on this path, so we enforce the role check in the handler.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const clients = await prisma.client.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, state: true, color: true },
  })
  return NextResponse.json({ clients })
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: {
    name?: unknown
    state?: unknown
    color?: unknown
    sortOrder?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  // Validation — name is the one truly required field. Color falls back
  // to a neutral blue if the picker wasn't touched. State is optional so
  // the create flow stays fast for cases where the location isn't known yet.
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }
  const state =
    typeof body.state === 'string' && body.state.trim()
      ? body.state.trim()
      : null
  const colorRaw = typeof body.color === 'string' ? body.color.trim() : ''
  // Loose hex validation — `#RGB` or `#RRGGBB`. Anything else falls back
  // to the schema default so a typo doesn't surface as a Prisma error.
  const color = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(colorRaw)
    ? colorRaw
    : '#3b82f6'
  const sortOrder =
    typeof body.sortOrder === 'number' && Number.isFinite(body.sortOrder)
      ? Math.round(body.sortOrder)
      : 0

  // Uniqueness — surfaces a clear error before Prisma throws on the
  // unique-name constraint, so the UI can show a useful message.
  const existing = await prisma.client.findUnique({ where: { name } })
  if (existing) {
    return NextResponse.json(
      { error: `A client named "${name}" already exists.` },
      { status: 409 }
    )
  }

  const client = await prisma.client.create({
    data: { name, state, color, sortOrder, active: true },
    select: { id: true, name: true, state: true, color: true },
  })
  return NextResponse.json({ client }, { status: 201 })
}
