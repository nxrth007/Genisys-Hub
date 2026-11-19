import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { canAccessPayments } from '@/lib/payments-access'
import { advance, assignDispute, disputeDetail, pauseDispute, saveNarrative } from '@/lib/disputes/run'

async function guard() {
  const session = await auth()
  if (!canAccessPayments(session?.user?.email)) return null
  return session
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await guard())) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { id } = await ctx.params
  const detail = await disputeDetail(id)
  if (!detail) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(detail)
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await guard()
  if (!session) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { id } = await ctx.params
  const actor = session.user?.email || session.user?.name || 'admin'
  const body = (await req.json().catch(() => null)) as { action?: string; narrative?: string; clientId?: string } | null
  try {
    switch (body?.action) {
      case 'pause':
        await pauseDispute(id, actor, true)
        break
      case 'resume':
        await pauseDispute(id, actor, false)
        break
      case 'narrative':
        await saveNarrative(id, actor, body.narrative ?? '')
        break
      case 'rebuild':
        await advance(id, actor, { forceRebuild: true })
        break
      case 'submit':
        await advance(id, actor, { forceSubmit: true })
        break
      case 'assign':
        if (!body.clientId) return NextResponse.json({ error: 'clientId required' }, { status: 400 })
        await assignDispute(id, actor, body.clientId)
        break
      default:
        return NextResponse.json({ error: 'unknown action' }, { status: 400 })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed'
    return NextResponse.json({ error: message }, { status: 400 })
  }
  const detail = await disputeDetail(id)
  return NextResponse.json(detail)
}
