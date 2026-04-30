import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * PATCH /api/call-center/callbacks/:id
 *   Staff-side toggle/edit for any agent's callback. Mirrors the
 *   agent endpoint at /api/agent/callbacks/:id but without the
 *   ownership filter — staff need to be able to mark any callback
 *   done from the /today follow-ups drawer.
 *
 * Middleware blocks role=agent from /api/call-center/* so the
 * session here is always staff (admin or member).
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { id } = await params

  let body: { completed?: unknown; notes?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const data: Record<string, unknown> = {}

  if (typeof body.completed === 'boolean') {
    // Setting completed=true stamps the timestamp; false clears it.
    // Same convention the agent endpoint uses.
    data.completedAt = body.completed ? new Date() : null
  }
  if (typeof body.notes === 'string') {
    const t = body.notes.trim()
    data.notes = t.length > 0 ? t : null
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'no fields to update' }, { status: 400 })
  }

  try {
    const callback = await prisma.callback.update({
      where: { id },
      data,
      include: { agent: { select: { id: true, name: true, email: true } } },
    })
    return NextResponse.json({ callback })
  } catch (err) {
    if (
      err instanceof Error &&
      'code' in err &&
      (err as { code?: string }).code === 'P2025'
    ) {
      return NextResponse.json({ error: 'callback not found' }, { status: 404 })
    }
    throw err
  }
}
