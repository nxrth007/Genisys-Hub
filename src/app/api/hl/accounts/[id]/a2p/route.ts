import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { hlAccountOr404, hlError, hlGuard, HlInputError, jsonBody } from '@/lib/hl/http'
import { a2pDraft, a2pPreflight, a2pView, advanceA2p, cleanDetails, fileA2p, resendA2pCode } from '@/lib/hl/a2p'

type Ctx = { params: Promise<{ id: string }> }

/**
 * GET: where the sub-account's A2P registration stands. ?draft=1 adds what
 * the review screen starts with; ?refresh=1 asks Twilio first.
 */
export async function GET(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  const sp = new URL(req.url).searchParams
  try {
    const a2p = sp.get('refresh') ? await advanceA2p(id) : await a2pView(id)
    if (!sp.get('draft')) return NextResponse.json({ a2p })
    return NextResponse.json({ a2p, ...(await a2pDraft(id)) })
  } catch (err) {
    return hlError(err, 'A2P status')
  }
}

/**
 * POST { action: 'check', details }: the pre-check (and keeps what was typed).
 * POST { action: 'file', details }: file it with Twilio. Costs money (the
 *   brand, then the campaign review), so the screen shows the price first.
 * POST { action: 'resend' }: sole proprietor, have the registry text the owner again.
 */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  try {
    const body = await jsonBody(req)
    if (body.action === 'check') {
      const details = cleanDetails(body.details)
      // Kept so the screen opens with it next time, unless it's already with Twilio.
      const existing = await prisma.hlA2p.findUnique({ where: { accountId: id }, select: { stage: true } })
      if (!existing || existing.stage === 'draft' || existing.stage === 'failed') {
        const data = { details: details as Prisma.InputJsonValue, ...(existing?.stage === 'failed' ? {} : { path: details.path }) }
        await prisma.hlA2p.upsert({ where: { accountId: id }, create: { accountId: id, ...data, path: details.path }, update: data })
      }
      return NextResponse.json({ checks: await a2pPreflight(id, details) })
    }
    if (body.action === 'file') {
      const checks = await a2pPreflight(id, body.details)
      const blocking = checks.filter((c) => c.level === 'error')
      if (blocking.length) throw new HlInputError(`Fix these first: ${blocking.map((c) => c.detail).join(' ')}`)
      const a2p = await fileA2p(id, body.details, guard.email)
      console.log(`[hell-level] ${guard.email} filed A2P (${a2p.path}) for ${account.name}: ${a2p.stage}`)
      return NextResponse.json({ a2p })
    }
    if (body.action === 'resend') {
      await resendA2pCode(id)
      return NextResponse.json({ ok: true })
    }
    throw new HlInputError('Unknown action.')
  } catch (err) {
    return hlError(err, 'A2P')
  }
}
