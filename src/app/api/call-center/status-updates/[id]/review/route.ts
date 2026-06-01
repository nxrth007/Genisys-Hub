import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * POST /api/call-center/status-updates/[id]/review
 *
 * Toggle the review state for one appointment's client-side status
 * update. Body: { reviewed: boolean }.
 *
 * Sets clientStatusReviewedAt + clientStatusReviewedById to (now,
 * caller) when reviewed=true; clears both back to null when false.
 * Idempotent — re-marking an already-reviewed row just refreshes the
 * timestamp and the reviewer in case Ethan and Alex both clicked it.
 *
 * 404s when the appointment doesn't exist OR doesn't have a
 * client-side update on it yet (you can't "review" something the
 * client never touched). 403s non-admin/member callers.
 */
export async function POST(
  req: NextRequest,
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
  let body: { reviewed?: unknown }
  try {
    body = (await req.json()) as { reviewed?: unknown }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (typeof body.reviewed !== 'boolean') {
    return NextResponse.json(
      { error: '`reviewed` must be a boolean' },
      { status: 400 },
    )
  }

  const existing = await prisma.appointment.findUnique({
    where: { id },
    select: { id: true, clientStatusUpdatedAt: true },
  })
  if (!existing) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  if (!existing.clientStatusUpdatedAt) {
    // Defensive — UI shouldn't render the toggle on non-updated
    // rows, but if someone hand-crafts the request, fail loudly
    // instead of silently storing a reviewed-without-update state.
    return NextResponse.json(
      { error: 'this appointment has no client-side update to review' },
      { status: 409 },
    )
  }

  const updated = await prisma.appointment.update({
    where: { id },
    data: body.reviewed
      ? {
          clientStatusReviewedAt: new Date(),
          clientStatusReviewedById: session.user.id,
        }
      : {
          clientStatusReviewedAt: null,
          clientStatusReviewedById: null,
        },
    select: {
      id: true,
      clientStatusReviewedAt: true,
      clientStatusReviewedBy: {
        select: { id: true, name: true, email: true },
      },
    },
  })

  return NextResponse.json({
    ok: true,
    appointment: {
      id: updated.id,
      clientStatusReviewedAt: updated.clientStatusReviewedAt?.toISOString() ?? null,
      clientStatusReviewedBy: updated.clientStatusReviewedBy
        ? {
            id: updated.clientStatusReviewedBy.id,
            name:
              updated.clientStatusReviewedBy.name ??
              updated.clientStatusReviewedBy.email,
          }
        : null,
    },
  })
}
