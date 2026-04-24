import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * PATCH /api/admin/schedules/[id]
 * Partial update for a ScheduledSms row. Currently the only field the UI
 * needs to toggle independently is `enabled` (pause / resume); other
 * fields go through the full upsert on POST /api/admin/schedules.
 *
 * Admin-only — middleware enforces role=admin.
 */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { id } = await ctx.params
  const body = (await req.json().catch(() => ({}))) as {
    enabled?: boolean
  }

  const data: Record<string, unknown> = {}
  if (typeof body.enabled === 'boolean') data.enabled = body.enabled

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 })
  }

  const existing = await prisma.scheduledSms.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const schedule = await prisma.scheduledSms.update({ where: { id }, data })
  return NextResponse.json({ ok: true, schedule })
}
