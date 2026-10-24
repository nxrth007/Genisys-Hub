import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { hlError, hlGuard } from '@/lib/hl/http'
import { refreshVerification, submitVerification, verificationDraft } from '@/lib/hl/verification'

type Ctx = { params: Promise<{ id: string; numberId: string }> }

async function owned(id: string, numberId: string) {
  const n = await prisma.hlPhoneNumber.findUnique({ where: { id: numberId }, select: { accountId: true } })
  return !!n && n.accountId === id
}

/** GET: what would be filed (?refresh=1: ask Twilio for the current status instead). */
export async function GET(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, numberId } = await params
  if (!(await owned(id, numberId))) return NextResponse.json({ error: 'Number not found' }, { status: 404 })
  try {
    if (new URL(req.url).searchParams.get('refresh')) return NextResponse.json(await refreshVerification(numberId))
    const { request } = await verificationDraft(numberId)
    return NextResponse.json({ request })
  } catch (err) {
    return hlError(err, 'verification')
  }
}

/** POST: file the toll-free verification with Twilio. */
export async function POST(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, numberId } = await params
  if (!(await owned(id, numberId))) return NextResponse.json({ error: 'Number not found' }, { status: 404 })
  try {
    const r = await submitVerification(numberId)
    console.log(`[hell-level] ${guard.email} filed toll-free verification ${r.sid} for number ${numberId}`)
    return NextResponse.json(r)
  } catch (err) {
    return hlError(err, 'file verification')
  }
}
