import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

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
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const config = await prisma.remindersConfig.upsert({
    where: { id: 'singleton' },
    update: {},
    create: { id: 'singleton' },
  })
  return NextResponse.json({ config })
}

export async function PATCH(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

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
