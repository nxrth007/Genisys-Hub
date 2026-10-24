import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { hlAccountOr404, hlError, hlGuard, HlInputError, jsonBody, str } from '@/lib/hl/http'
import { toE164 } from '@/lib/hl/phone'
import { staffOf } from '@/lib/hl/staff'

type Ctx = { params: Promise<{ id: string }> }

/** GET: the sub-account's staff (GHL's My Staff): imported GHL users and people added here. */
export async function GET(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  return NextResponse.json({ staff: await staffOf(id) })
}

/** POST { name, email?, phone? }: someone who takes bookings (a calendar team member). */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  try {
    const body = await jsonBody(req)
    const name = str(body.name)?.slice(0, 120)
    if (!name) throw new HlInputError('Add their name.')
    const email = str(body.email)?.toLowerCase().slice(0, 200) ?? null
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HlInputError('That email doesn’t look right.')
    const raw = str(body.phone)
    const phone = raw ? toE164(raw) : null
    if (raw && !phone) throw new HlInputError('That phone number doesn’t look right.')
    const row = await prisma.hlRecord.create({ data: { accountId: id, kind: 'user', name, data: { email, phone, addedBy: guard.email } } })
    return NextResponse.json({ staff: { id: row.id, ghlId: null, name, email, phone } })
  } catch (err) {
    return hlError(err, 'add staff')
  }
}

/** DELETE ?staffId=: remove someone added here (people imported from GHL stay). */
export async function DELETE(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const staffId = new URL(req.url).searchParams.get('staffId') ?? ''
  const row = await prisma.hlRecord.findUnique({ where: { id: staffId } })
  if (!row || row.accountId !== id || row.kind !== 'user') return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (row.ghlId) return NextResponse.json({ error: 'People imported from GoHighLevel stay; take them off a calendar’s team instead.' }, { status: 400 })
  await prisma.hlRecord.delete({ where: { id: staffId } })
  return NextResponse.json({ ok: true })
}
