import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/auth'
import { sendEmail } from '@/lib/gmail'

const BodySchema = z.object({
  accountEmail: z.string().email(),
  to: z.string().min(1),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(100000),
  inReplyTo: z.string().optional(),
  threadId: z.string().optional(),
})

/**
 * POST /api/emails/send
 * Sends an email (or reply if inReplyTo/threadId provided) from the given
 * connected account.
 */
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => null)
  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 })
  }

  try {
    const result = await sendEmail(parsed.data)
    return NextResponse.json({ ok: true, messageId: result.id, threadId: result.threadId })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'send failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
