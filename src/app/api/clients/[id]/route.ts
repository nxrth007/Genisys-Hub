import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { normalizeClientPatch } from '@/lib/clients'

/**
 * PATCH /api/clients/:id
 *   Partial update — any subset of name, state, color, lifecycle,
 *   contact*, address, notes, intakeFormUrl, ghlSubaccountUrl. Used
 *   by both the row-level status select on /clients and the full
 *   edit dialog.
 *
 * Admin-only: route is reachable by any signed-in user (the agent
 * allow-list includes /api/clients) but middleware doesn't gate by
 * HTTP method, so we enforce role here.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  // Staff-only: both admin and member roles are staff and need to
  // manage clients. Agents (+ pending/denied) are blocked — earlier
  // this was `role !== 'admin'`, which blocked Ethan (role=member)
  // from saving edits with a misleading 403.
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

  const parsed = normalizeClientPatch(body)
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 })
  }
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: 'no fields to update' }, { status: 400 })
  }

  // If the admin is renaming the client, pre-check uniqueness so the
  // error stays human-readable.
  if (parsed.data.name) {
    const conflict = await prisma.client.findFirst({
      where: { name: parsed.data.name, id: { not: id } },
    })
    if (conflict) {
      return NextResponse.json(
        { error: `A client named "${parsed.data.name}" already exists.` },
        { status: 409 }
      )
    }
  }

  try {
    const client = await prisma.client.update({
      where: { id },
      data: parsed.data,
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
        active: true,
      },
    })
    return NextResponse.json({ client })
  } catch (err) {
    // Most likely cause: client not found. Prisma throws P2025 in that
    // case; surfacing as 404 is the friendlier API contract.
    if (
      err instanceof Error &&
      'code' in err &&
      (err as { code?: string }).code === 'P2025'
    ) {
      return NextResponse.json({ error: 'client not found' }, { status: 404 })
    }
    throw err
  }
}
