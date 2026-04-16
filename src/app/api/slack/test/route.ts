import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/auth'
import { sendDmByEmail } from '@/lib/slack'

const BodySchema = z.object({
  email: z.string().email('Must be a valid email address'),
  message: z.string().min(1).max(4000),
})

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const raw = await req.json().catch(() => null)
  const parsed = BodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || 'invalid body' },
      { status: 400 }
    )
  }

  try {
    const result = await sendDmByEmail({
      email: parsed.data.email,
      text: parsed.data.message,
    })

    if (!result) {
      return NextResponse.json(
        {
          error: `No Slack user found for ${parsed.data.email}. Make sure they're a member of the workspace.`,
        },
        { status: 404 }
      )
    }

    return NextResponse.json({
      ok: true,
      channel: result.channel,
      ts: result.ts,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
