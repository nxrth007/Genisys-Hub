import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { listChannels } from '@/lib/slack'

/**
 * GET /api/slack/channels
 * List all channels the bot can see in the workspace.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const channels = await listChannels()
    return NextResponse.json({ channels })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list channels'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
