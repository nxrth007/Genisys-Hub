import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/auth'
import { sendSms, isValidE164 } from '@/lib/twilio'

const BodySchema = z.object({
  to: z.string().refine(isValidE164, {
    message: 'Phone number must be in E.164 format (e.g. +16035026226)',
  }),
  body: z.string().min(1).max(1600),
})

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const raw = await req.json().catch(() => null)
  const parsed = BodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || 'invalid body' }, { status: 400 })
  }

  try {
    const result = await sendSms(parsed.data)
    return NextResponse.json({
      ok: true,
      sid: result.sid,
      status: result.status,
      from: result.from,
    })
  } catch (err) {
    // Surface the raw error so the user can see "Vault entry not found" vs
    // a Twilio auth failure vs a rate limit, all of which need different fixes.
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
