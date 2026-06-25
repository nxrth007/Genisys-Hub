import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET  /api/call-center/reminders/pause  → { pausedPhones: string[] }
 * POST /api/call-center/reminders/pause  body { phone, paused: boolean }
 *
 * "Pause Lead" on the master tracker. Pausing records the customer's
 * normalized phone; the reminder dispatcher then HOLDS (doesn't send,
 * doesn't cancel) every reminder for that phone. Resuming clears it
 * and the held reminders fire again on a later tick. Keyed by phone
 * so it works whether the appointment is a DB row or sheet-only.
 *
 * Open to the staff who manage the tracker — admin, member, and the
 * call-center agents (Mary / Hannah).
 */
const ALLOWED = new Set(['admin', 'member', 'agent', 'team_member'])

/** Normalize to bare 10-digit US form (same shape the reminder
 *  dispatcher matches on). Returns '' when not a usable phone. */
function normalize(raw: string): string {
  const d = raw.replace(/\D/g, '')
  if (d.length === 10) return d
  if (d.length === 11 && d.startsWith('1')) return d.slice(1)
  if (d.length > 10) return d.slice(-10)
  return ''
}

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role ?? ''
  if (!ALLOWED.has(role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const rows = await prisma.reminderPause.findMany({
    select: { customerPhone: true },
  })
  return NextResponse.json(
    { pausedPhones: rows.map((r) => r.customerPhone) },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role ?? ''
  if (!ALLOWED.has(role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: { phone?: unknown; paused?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const phone = normalize(typeof body.phone === 'string' ? body.phone : '')
  if (!phone) {
    return NextResponse.json(
      { error: 'a valid 10-digit phone is required' },
      { status: 400 },
    )
  }
  const paused = body.paused === true

  if (paused) {
    await prisma.reminderPause.upsert({
      where: { customerPhone: phone },
      create: {
        customerPhone: phone,
        pausedByUserId: session.user.id,
        pausedByName:
          (session.user as { name?: string | null }).name ??
          session.user.email ??
          null,
      },
      update: {},
    })
  } else {
    await prisma.reminderPause.deleteMany({ where: { customerPhone: phone } })
  }

  return NextResponse.json({ ok: true, phone, paused })
}
