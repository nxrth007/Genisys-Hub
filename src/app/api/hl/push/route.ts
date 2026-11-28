import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { canAccessHellLevel } from '@/lib/hl/access'
import { HlInputError, hlError, jsonBody, str } from '@/lib/hl/http'
import { HL_MEMBER_ROLE } from '@/lib/hl/member-access'
import { pushStatus, removePushDevice, savePushDevice } from '@/lib/hl/push'

/**
 * Genisys OS notifications on this phone or browser (src/lib/hl/push.ts):
 * - GET ?endpoint=&accountId=: the Hub's public key (what the browser subscribes with) and whether this device is on.
 * - POST { endpoint, keys: { p256dh, auth }, accountId?, replaces? }: turn it on.
 * - DELETE { endpoint, accountId? }: turn it off.
 *
 * A contractor's device covers every sub-account they're on. Genisys staff follow sub-accounts one
 * at a time (accountId), so they only hear about the clients they chose. Signed in either way.
 */

type Who = { userId: string; staff: boolean }

async function who(): Promise<Who | NextResponse> {
  const session = await auth()
  const email = session?.user?.email?.toLowerCase()
  const userId = session?.user?.id
  if (!email || !userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (session.user.role === HL_MEMBER_ROLE) {
    const member = await prisma.hlMember.findFirst({ where: { userId, account: { archivedAt: null } }, select: { id: true } })
    if (!member) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    return { userId, staff: false }
  }
  if (canAccessHellLevel(email)) return { userId, staff: true }
  return NextResponse.json({ error: 'forbidden' }, { status: 403 })
}

/** Staff name the sub-account to follow; it has to exist. A contractor's device is never scoped (it's all theirs). */
async function followed(w: Who, accountId: string | null): Promise<string | null> {
  if (!w.staff || !accountId) return null
  const a = await prisma.hlAccount.findUnique({ where: { id: accountId }, select: { id: true } })
  if (!a) throw new HlInputError('Sub-account not found.')
  return a.id
}

export async function GET(req: Request) {
  const w = await who()
  if (w instanceof NextResponse) return w
  try {
    const sp = new URL(req.url).searchParams
    return NextResponse.json(await pushStatus({ userId: w.userId, endpoint: str(sp.get('endpoint')), accountId: w.staff ? str(sp.get('accountId')) : null }))
  } catch (err) {
    return hlError(err, 'push status')
  }
}

export async function POST(req: Request) {
  const w = await who()
  if (w instanceof NextResponse) return w
  try {
    const body = await jsonBody(req)
    const keys = (body.keys && typeof body.keys === 'object' ? body.keys : {}) as Record<string, unknown>
    const endpoint = str(body.endpoint)
    const p256dh = str(keys.p256dh)
    const authKey = str(keys.auth)
    if (!endpoint || !p256dh || !authKey) throw new HlInputError('The browser didn’t send a full subscription.')
    await savePushDevice({
      userId: w.userId,
      staff: w.staff,
      device: { endpoint, p256dh, auth: authKey },
      follow: await followed(w, str(body.accountId)),
      replaces: str(body.replaces),
      userAgent: req.headers.get('user-agent'),
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return hlError(err, 'push subscribe')
  }
}

export async function DELETE(req: Request) {
  const w = await who()
  if (w instanceof NextResponse) return w
  try {
    const body = await jsonBody(req)
    const endpoint = str(body.endpoint)
    if (!endpoint) throw new HlInputError('Which device?')
    await removePushDevice({ userId: w.userId, endpoint, unfollow: w.staff ? str(body.accountId) : null })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return hlError(err, 'push unsubscribe')
  }
}
