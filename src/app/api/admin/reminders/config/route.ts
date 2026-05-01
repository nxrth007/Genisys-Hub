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
    quietHoursStart?: unknown
    quietHoursEnd?: unknown
    senderPhone?: unknown
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
    quietHoursStart?: string
    quietHoursEnd?: string
    senderPhone?: string | null
  } = {}

  if (typeof body.enabled === 'boolean') data.enabled = body.enabled
  if (typeof body.vaultEntryName === 'string') {
    const t = body.vaultEntryName.trim()
    if (t) data.vaultEntryName = t
  }
  if (typeof body.lookaheadDays === 'number' && body.lookaheadDays > 0) {
    data.lookaheadDays = Math.min(60, Math.round(body.lookaheadDays))
  }
  // HH:mm validation — anything that doesn't match gets dropped
  // rather than throwing, so a tooltip-typo doesn't crash the save.
  const isHHmm = (s: string) => /^\d{1,2}:\d{2}$/.test(s.trim())
  if (typeof body.quietHoursStart === 'string' && isHHmm(body.quietHoursStart)) {
    data.quietHoursStart = body.quietHoursStart.trim()
  }
  if (typeof body.quietHoursEnd === 'string' && isHHmm(body.quietHoursEnd)) {
    data.quietHoursEnd = body.quietHoursEnd.trim()
  }
  // senderPhone: empty / null clears (fall back to GHL default).
  // Anything else gets normalized to E.164 so the GHL API accepts it.
  if (body.senderPhone === null || body.senderPhone === '') {
    data.senderPhone = null
  } else if (typeof body.senderPhone === 'string') {
    const digits = body.senderPhone.replace(/\D/g, '')
    if (digits.length === 10) {
      data.senderPhone = `+1${digits}`
    } else if (digits.length === 11 && digits.startsWith('1')) {
      data.senderPhone = `+${digits}`
    } else if (body.senderPhone.startsWith('+')) {
      // Already E.164-ish — let it through verbatim. GHL will validate.
      data.senderPhone = body.senderPhone.trim()
    }
    // Anything else (too few digits, garbage) is silently ignored
    // rather than crashing the save — the input had a placeholder
    // showing the right format.
  }

  const config = await prisma.remindersConfig.upsert({
    where: { id: 'singleton' },
    update: data,
    create: { id: 'singleton', ...data },
  })
  return NextResponse.json({ config })
}
