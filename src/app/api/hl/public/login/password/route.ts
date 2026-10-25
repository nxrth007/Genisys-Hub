import { NextResponse } from 'next/server'
import { hlError } from '@/lib/hl/http'
import { checkPasswordLink, setPasswordFromLink } from '@/lib/hl/logins'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'

/** The set-password link (/login/password?u=&t=): an invite's or a reset's. */

const tooMany = () => NextResponse.json({ error: 'Too many tries. Wait a few minutes and try again.' }, { status: 429 })

/** GET ?u=&t=: whose link it is, while it's good. */
export async function GET(req: Request) {
  if (!checkRateLimit(`hl-password:${clientIp(req)}`, 20, 15 * 60_000).ok) return tooMany()
  const sp = new URL(req.url).searchParams
  try {
    const { email } = await checkPasswordLink(sp.get('u') ?? '', sp.get('t') ?? '')
    return NextResponse.json({ email })
  } catch (err) {
    return hlError(err, 'check a password link')
  }
}

/** POST { u, t, password }: choose the password. The link is used up. */
export async function POST(req: Request) {
  if (!checkRateLimit(`hl-password:${clientIp(req)}`, 20, 15 * 60_000).ok) return tooMany()
  const body = (await req.json().catch(() => null)) as { u?: unknown; t?: unknown; password?: unknown } | null
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  try {
    return NextResponse.json(await setPasswordFromLink(s(body?.u), s(body?.t), s(body?.password)))
  } catch (err) {
    return hlError(err, 'set a password')
  }
}
