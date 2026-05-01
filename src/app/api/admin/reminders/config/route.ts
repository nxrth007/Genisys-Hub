import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireStaff } from '@/lib/auth-helpers'

/**
 * GET  /api/admin/reminders/config
 *   Returns the singleton RemindersConfig (master enable, vault key,
 *   lookahead window).
 *
 * PATCH /api/admin/reminders/config
 *   Updates any subset of those fields. Admin-only — middleware
 *   already gates /api/admin/* to role=admin.
 */
export async function GET() {
  const denial = await requireStaff()
  if (denial) return denial
  const config = await prisma.remindersConfig.upsert({
    where: { id: 'singleton' },
    update: {},
    create: { id: 'singleton' },
  })
  return NextResponse.json({ config })
}

export async function PATCH(req: Request) {
  const denial = await requireStaff()
  if (denial) return denial

  let body: {
    enabled?: unknown
    vaultEntryName?: unknown
    lookaheadDays?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const data: {
    enabled?: boolean
    vaultEntryName?: string
    lookaheadDays?: number
  } = {}

  if (typeof body.enabled === 'boolean') data.enabled = body.enabled
  if (typeof body.vaultEntryName === 'string') {
    const t = body.vaultEntryName.trim()
    if (t) data.vaultEntryName = t
  }
  if (typeof body.lookaheadDays === 'number' && body.lookaheadDays > 0) {
    data.lookaheadDays = Math.min(60, Math.round(body.lookaheadDays))
  }

  const config = await prisma.remindersConfig.upsert({
    where: { id: 'singleton' },
    update: data,
    create: { id: 'singleton', ...data },
  })
  return NextResponse.json({ config })
}
