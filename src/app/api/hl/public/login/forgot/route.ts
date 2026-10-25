import { NextResponse } from 'next/server'
import { requestPasswordReset } from '@/lib/hl/logins'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'

/**
 * POST { email }: "Forgot password?" on /login. Always the same answer, as
 * fast whether or not the email has a login: the link goes out after.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { email?: unknown } | null
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase().slice(0, 200) : ''
  const ip = clientIp(req)
  if (!checkRateLimit(`hl-forgot-ip:${ip}`, 5, 15 * 60_000).ok) return NextResponse.json({ error: 'Too many tries. Wait a few minutes and try again.' }, { status: 429 })
  if (email && checkRateLimit(`hl-forgot-email:${email}`, 3, 60 * 60_000).ok) {
    void requestPasswordReset(email).catch((err) => console.error('[hell-level] password reset failed:', err))
  }
  return NextResponse.json({ ok: true })
}
