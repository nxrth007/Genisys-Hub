import { NextRequest, NextResponse } from 'next/server'
import { loginCrmUser } from '@/lib/external-auth'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'
import { corsPreflight, withCors } from '@/lib/external-cors'

/**
 * POST /api/external/v1/auth/login — public.
 *
 * Returns a session token on success. Errors stay generic so this can't
 * be used to discover which email addresses have accounts.
 */
export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin')

  // Tighter than registration: this is the endpoint worth brute-forcing.
  const limit = checkRateLimit(`crm-login:${clientIp(req)}`, 10, 10 * 60 * 1000)
  if (!limit.ok) {
    return withCors(
      NextResponse.json(
        { error: 'Too many sign-in attempts. Try again in a few minutes.' },
        { status: 429 },
      ),
      origin,
    )
  }

  let body: { email?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return withCors(
      NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }),
      origin,
    )
  }

  const result = await loginCrmUser(
    String(body.email ?? ''),
    String(body.password ?? ''),
  )

  if (!result.ok) {
    return withCors(
      NextResponse.json(
        { error: result.error, pending: result.pending ?? false },
        { status: result.pending ? 403 : 401 },
      ),
      origin,
    )
  }

  return withCors(
    NextResponse.json({ ok: true, token: result.token, user: result.user }),
    origin,
  )
}

export const OPTIONS = (req: NextRequest) => corsPreflight(req)
