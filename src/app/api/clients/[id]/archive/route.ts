import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * POST /api/clients/:id/archive  { archived: boolean }
 *
 * Archiving hides a client from the roster and every picker without
 * deleting anything — history, appointments and logins stay intact,
 * and it reverses cleanly. The legacy `active` flag follows along so
 * older list consumers that still filter on it agree with the
 * archived state.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await params
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const archived = (body as { archived?: unknown })?.archived
  if (typeof archived !== 'boolean') {
    return NextResponse.json({ error: 'archived must be a boolean' }, { status: 400 })
  }

  const existing = await prisma.client.findUnique({
    where: { id },
    select: { id: true, name: true, lifecycle: true },
  })
  if (!existing) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const client = await prisma.client.update({
    where: { id },
    data: {
      archivedAt: archived ? new Date() : null,
      active: archived
        ? false
        : ['active', 'onboarding', 'paused'].includes(existing.lifecycle),
    },
    select: { id: true, name: true, archivedAt: true, active: true },
  })

  console.log(
    `[clients] ${session.user.email} ${archived ? 'archived' : 'restored'} "${client.name}" (${id})`,
  )
  return NextResponse.json({ client })
}
