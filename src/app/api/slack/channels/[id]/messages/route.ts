import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/auth'
import { getChannelMessages, postChannelMessage, joinChannel, formatSlackError } from '@/lib/slack'

/**
 * GET /api/slack/channels/[id]/messages
 * Fetch recent messages from a channel. Auto-joins the channel if the bot
 * isn't already a member (public channels only).
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { id } = await ctx.params

  try {
    // Ensure the bot is in the channel (no-op if already a member)
    await joinChannel(id)
    const data = await getChannelMessages(id)
    return NextResponse.json(data)
  } catch (err) {
    return NextResponse.json({ error: formatSlackError(err) }, { status: 500 })
  }
}

const PostSchema = z.object({
  text: z.string().min(1).max(4000),
  threadTs: z.string().optional(),
})

/**
 * POST /api/slack/channels/[id]/messages
 * Send a message to a channel (as the bot). Optionally provide threadTs
 * to reply in a thread.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { id } = await ctx.params
  const body = await req.json().catch(() => null)
  const parsed = PostSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || 'invalid body' }, { status: 400 })
  }

  try {
    const result = await postChannelMessage(id, parsed.data.text, parsed.data.threadTs)
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json({ error: formatSlackError(err) }, { status: 500 })
  }
}
