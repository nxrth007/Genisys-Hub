import { NextRequest, NextResponse } from 'next/server'
import { registerCrmUser } from '@/lib/external-auth'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'
import { corsPreflight, withCors } from '@/lib/external-cors'

/**
 * POST /api/external/v1/auth/register — public.
 *
 * Creates a PENDING account. Approval is a deliberate human step: this
 * frontend reads real client data from a shareable URL, so signing up
 * must not grant access.
 */
export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin')

  const limit = checkRateLimit(`crm-register:${clientIp(req)}`, 5, 10 * 60 * 1000)
  if (!limit.ok) {
    return withCors(
      NextResponse.json(
        { error: 'Too many attempts. Try again in a few minutes.' },
        { status: 429 },
      ),
      origin,
    )
  }

  let body: { name?: string; email?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return withCors(
      NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }),
      origin,
    )
  }

  const result = await registerCrmUser(
    String(body.name ?? ''),
    String(body.email ?? ''),
    String(body.password ?? ''),
  )

  if (!result.ok) {
    return withCors(
      NextResponse.json({ error: result.error }, { status: 400 }),
      origin,
    )
  }

  return withCors(
    NextResponse.json({
      ok: true,
      message:
        'Request received. An admin will approve your account before you can sign in.',
    }),
    origin,
  )
}

export const OPTIONS = (req: NextRequest) => corsPreflight(req)
