import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { validateClientCreate } from '@/lib/clients'

/**
 * GET  /api/clients
 *   Returns the active client list with primary-contact metadata.
 *   Used by both the agent appointment form and staff filters.
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
    select: {
      id: true,
      name: true,
      state: true,
      color: true,
      lifecycle: true,
      contactName: true,
      contactRole: true,
      contactEmail: true,
      contactPhone: true,
      address: true,
      notes: true,
      intakeFormUrl: true,
      ghlSubaccountUrl: true,
      slackChannelId: true,
      slackChannelName: true,
    },
  })
  return NextResponse.json({ clients })
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  // Staff-only: agents (and pending/denied) can read clients via GET
  // for their booking picker, but they can't create. Both admin and
  // member are staff and should both be able to manage clients —
  // earlier this check was `role !== 'admin'`, which blocked Ethan
  // (role=member) from saving edits.
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const parsed = validateClientCreate(body)
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 })
  }

  // Pre-check uniqueness so the error message stays human-readable
  // instead of surfacing as a Prisma constraint violation.
  const existing = await prisma.client.findUnique({
    where: { name: parsed.data.name },
  })
  if (existing) {
    return NextResponse.json(
      { error: `A client named "${parsed.data.name}" already exists.` },
      { status: 409 }
    )
  }

  const client = await prisma.client.create({
    data: {
      ...parsed.data,
      active: true,
    },
    select: {
      id: true,
      name: true,
      state: true,
      color: true,
      lifecycle: true,
      contactName: true,
      contactRole: true,
      contactEmail: true,
      contactPhone: true,
      address: true,
      notes: true,
      intakeFormUrl: true,
      ghlSubaccountUrl: true,
    },
  })
  return NextResponse.json({ client }, { status: 201 })
}

