import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/auth'
import { buildAndSendBrief } from '@/lib/morning-brief'

const BodySchema = z.object({
  email: z.string().email('Must be a valid email'),
})

/**
 * POST /api/today/brief
 * Manually trigger a morning brief for testing.
 * Builds the brief from today's tasks + calendar, sends as a Slack DM.
 */
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => null)
  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || 'invalid body' }, { status: 400 })
  }

  try {
    const result = await buildAndSendBrief(parsed.data.email)
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
