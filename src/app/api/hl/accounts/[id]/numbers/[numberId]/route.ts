import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { hlError, hlGuard, HlInputError, jsonBody } from '@/lib/hl/http'
import { toE164 } from '@/lib/hl/phone'
import { releaseNumber, repointNumber } from '@/lib/hl/twilio'

type Ctx = { params: Promise<{ id: string; numberId: string }> }

async function load(id: string, numberId: string) {
  const n = await prisma.hlPhoneNumber.findUnique({ where: { id: numberId } })
  return n && n.accountId === id && n.status === 'active' ? n : null
}

/** PATCH { forwardTo?: string|null, whisper?: boolean, isDefault?: true, repoint?: true } */
export async function PATCH(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, numberId } = await params
  const number = await load(id, numberId)
  if (!number) return NextResponse.json({ error: 'Number not found' }, { status: 404 })
  try {
    const body = await jsonBody(req)
    if (body.repoint === true) {
      if (!number.providerSid) throw new HlInputError('This number has no Twilio id.')
      await repointNumber(number.providerSid)
      return NextResponse.json({ ok: true })
    }
    const data: Prisma.HlPhoneNumberUpdateInput = {}
    if ('forwardTo' in body) {
      const raw = typeof body.forwardTo === 'string' ? body.forwardTo.trim() : ''
      const p = raw ? toE164(raw) : null
      if (raw && !p) throw new HlInputError('That forwarding number doesn’t look right.')
      if (p && p === number.number) throw new HlInputError('A number can’t forward to itself.')
      data.forwardTo = p
    }
    if (typeof body.whisper === 'boolean') data.whisper = body.whisper
    if (body.isDefault === true) {
      await prisma.hlPhoneNumber.updateMany({ where: { accountId: id, id: { not: numberId } }, data: { isDefault: false } })
      data.isDefault = true
    }
    return NextResponse.json({ number: await prisma.hlPhoneNumber.update({ where: { id: numberId }, data }) })
  } catch (err) {
    return hlError(err, 'update number')
  }
}

/** DELETE: release the number back to Twilio. Irreversible, so the page asks first. */
export async function DELETE(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, numberId } = await params
  const number = await load(id, numberId)
  if (!number) return NextResponse.json({ error: 'Number not found' }, { status: 404 })
  try {
    await releaseNumber(numberId)
    console.log(`[hell-level] ${guard.email} released ${number.number}`)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return hlError(err, 'release number')
  }
}
