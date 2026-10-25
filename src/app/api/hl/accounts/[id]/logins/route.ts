import { NextResponse } from 'next/server'
import { hlAccountOr404, hlError, hlGuard, HlInputError, jsonBody, str } from '@/lib/hl/http'
import { inviteLogin, loginsOf, removeLogin } from '@/lib/hl/logins'

type Ctx = { params: Promise<{ id: string }> }

/** GET: who can log in to this sub-account (Settings → My Staff). */
export async function GET(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  return NextResponse.json({ logins: await loginsOf(id) })
}

/** POST { staffId, email? }: give someone on My Staff a login (or a fresh link), sent by email and text. */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  try {
    const body = await jsonBody(req)
    const staffId = str(body.staffId)
    if (!staffId) throw new HlInputError('Pick who to invite.')
    return NextResponse.json(await inviteLogin({ accountId: id, staffId, email: str(body.email), by: guard.email }))
  } catch (err) {
    return hlError(err, 'invite a login')
  }
}

/** DELETE ?userId=: take a login off this sub-account (they're signed out). */
export async function DELETE(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const userId = new URL(req.url).searchParams.get('userId') ?? ''
  if (!userId) return NextResponse.json({ error: 'userId is required' }, { status: 400 })
  await removeLogin(id, userId)
  return NextResponse.json({ ok: true })
}
