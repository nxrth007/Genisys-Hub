import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET  /api/team/callbacks  → own callbacks, soonest first
 * POST /api/team/callbacks  → create a callback
 *
 * Mirror of /api/agent/callbacks — writes to the same Callback
 * table. Difference is the URL prefix (so middleware permits
 * team_member) and the role gate (team_member only). Same
 * (agentUserId, completedAt, callbackAt) ordering for the list.
 */

const ALLOWED_ROLES = new Set(['team_member'])

type CallbackInput = {
  customerName?: string
  customerPhone?: string
  callbackAt?: string
  notes?: string | null
}

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role ?? ''
  if (!ALLOWED_ROLES.has(role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const callbacks = await prisma.callback.findMany({
    where: { agentUserId: session.user.id },
    orderBy: [{ completedAt: 'asc' }, { callbackAt: 'asc' }],
  })
  return NextResponse.json({ callbacks })
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role ?? ''
  if (!ALLOWED_ROLES.has(role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: CallbackInput
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.customerName?.trim()) {
    return NextResponse.json(
      { error: "Customer's name is required." },
      { status: 400 },
    )
  }
  if (!body.customerPhone?.trim()) {
    return NextResponse.json(
      { error: "Customer's phone number is required." },
      { status: 400 },
    )
  }
  if (!body.callbackAt) {
    return NextResponse.json(
      { error: 'Callback date/time is required.' },
      { status: 400 },
    )
  }
  const when = new Date(body.callbackAt)
  if (isNaN(when.getTime())) {
    return NextResponse.json({ error: 'Invalid date/time.' }, { status: 400 })
  }

  const callback = await prisma.callback.create({
    data: {
      agentUserId: session.user.id,
      customerName: body.customerName.trim(),
      customerPhone: body.customerPhone.trim(),
      callbackAt: when,
      notes: body.notes?.trim() || null,
    },
  })
  return NextResponse.json({ ok: true, callback })
}
