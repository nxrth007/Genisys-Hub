import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/auth'
import { sendMessage } from '@/lib/ghl'

const BodySchema = z.object({
  conversationId: z.string().min(1),
  contactId: z.string().optional(),
  message: z.string().min(1).max(20000),
  type: z.enum(['Email', 'SMS']).default('Email'),
})

/**
 * POST /api/crm/messages/[subName]
 * Sends a reply in the specified sub-account's GHL. `subName` is the
 * URL-encoded vault entry name of the sub-account.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ subName: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { subName } = await ctx.params
  const vaultName = decodeURIComponent(subName)

  const body = await req.json().catch(() => null)
  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || 'invalid body' }, { status: 400 })
  }

  try {
    const result = await sendMessage(vaultName, parsed.data)
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to send message'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
