import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET/PATCH/DELETE /api/team/callbacks/[id]
 *
 * Mirror of /api/agent/callbacks/[id] gated to team_member.
 * Ownership enforced via (id, agentUserId) so a team_member can't
 * touch another user's callbacks even by guessing the id.
 */

const ALLOWED_ROLES = new Set(['team_member'])

const ALLOWED_OUTCOMES = new Set([
  'booked',
  'not_interested',
  'no_answer',
  'rescheduled',
  'other',
])

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t.length > 0 ? t : undefined
}
function strOrNull(v: unknown): string | null | undefined {
  if (v === null) return null
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t.length > 0 ? t : null
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role ?? ''
  if (!ALLOWED_ROLES.has(role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const { id } = await ctx.params
  const callback = await prisma.callback.findFirst({
    where: { id, agentUserId: session.user.id },
  })
  if (!callback) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  return NextResponse.json({ callback })
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role ?? ''
  if (!ALLOWED_ROLES.has(role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const { id } = await ctx.params

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const owned = await prisma.callback.findFirst({
    where: { id, agentUserId: session.user.id },
    select: { id: true },
  })
  if (!owned) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const data: Record<string, unknown> = {}
  const cn = str(body.customerName)
  if (cn !== undefined) data.customerName = cn
  const cp = str(body.customerPhone)
  if (cp !== undefined) data.customerPhone = cp

  if (body.callbackAt) {
    const d = new Date(String(body.callbackAt))
    if (!isNaN(d.getTime())) data.callbackAt = d
  }

  const notes = strOrNull(body.notes)
  if (notes !== undefined) data.notes = notes

  const crl = strOrNull(body.callRecordingLink)
  if (crl !== undefined) data.callRecordingLink = crl

  if (body.completed === true) {
    data.completedAt = new Date()
  } else if (body.completed === false) {
    data.completedAt = null
    data.outcome = null
  } else if (typeof body.completedAt === 'string') {
    const d = new Date(body.completedAt)
    if (!isNaN(d.getTime())) data.completedAt = d
  } else if (body.completedAt === null) {
    data.completedAt = null
    data.outcome = null
  }

  if (typeof body.outcome === 'string') {
    const o = body.outcome.trim()
    if (ALLOWED_OUTCOMES.has(o)) data.outcome = o
  } else if (body.outcome === null) {
    data.outcome = null
  }

  const updated = await prisma.callback.update({ where: { id }, data })
  return NextResponse.json({ ok: true, callback: updated })
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role ?? ''
  if (!ALLOWED_ROLES.has(role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const { id } = await ctx.params
  const owned = await prisma.callback.findFirst({
    where: { id, agentUserId: session.user.id },
    select: { id: true },
  })
  if (!owned) return NextResponse.json({ error: 'not found' }, { status: 404 })
  await prisma.callback.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
