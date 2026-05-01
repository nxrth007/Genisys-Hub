import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { sendTestClientDelivery } from '@/lib/client-delivery'

/**
 * POST /api/admin/slack-delivery/test
 *
 * Sends a clearly-labeled sample appointment post to a Slack channel
 * so admins can verify the routing wired up in Settings is hitting
 * the channel they expect. Body:
 *   { channelId: string, clientName: string }
 *
 * Doesn't write to the SheetSlackDelivery ledger — test posts are
 * one-shot and we don't want them gumming up the idempotency state
 * for real rows.
 */
export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: { channelId?: unknown; clientName?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const channelId =
    typeof body.channelId === 'string' ? body.channelId.trim() : ''
  const clientName =
    typeof body.clientName === 'string' && body.clientName.trim()
      ? body.clientName.trim()
      : 'Sample Client'
  if (!channelId) {
    return NextResponse.json(
      { error: 'channelId is required' },
      { status: 400 }
    )
  }

  try {
    const result = await sendTestClientDelivery({ channelId, clientName })
    return NextResponse.json({ ok: true, ts: result.ts })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Send failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
