import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { undoClientDeliveries } from '@/lib/client-delivery'

/**
 * POST /api/admin/slack-delivery/undo
 *
 * Recovers from a misconfiguration where the sync posted historical
 * rows that should have been backfilled. Deletes recent 'delivered'
 * messages from Slack AND flips the ledger entries to 'backfilled'
 * so the rows stay tracked (don't re-post) without leaving stale
 * messages in the channel.
 *
 * Body:
 *   {
 *     clientId: string         // which client's deliveries to undo
 *     sinceHoursAgo?: number   // safety bound, default 24
 *   }
 *
 * Resolves the client's currently-configured channel automatically
 * — admins shouldn't have to remember channel IDs to fix a mistake.
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

  let body: { clientId?: unknown; sinceHoursAgo?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const clientId =
    typeof body.clientId === 'string' ? body.clientId.trim() : ''
  const sinceHoursAgo =
    typeof body.sinceHoursAgo === 'number' && body.sinceHoursAgo > 0
      ? Math.min(body.sinceHoursAgo, 24 * 7) // cap at 7 days
      : 24
  if (!clientId) {
    return NextResponse.json(
      { error: 'clientId is required' },
      { status: 400 }
    )
  }

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, name: true, slackChannelId: true },
  })
  if (!client?.slackChannelId) {
    return NextResponse.json(
      { error: 'client has no Slack channel configured' },
      { status: 400 }
    )
  }

  try {
    const result = await undoClientDeliveries({
      clientId: client.id,
      channelId: client.slackChannelId,
      sinceHoursAgo,
    })
    return NextResponse.json({
      ok: true,
      clientName: client.name,
      ...result,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'undo failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
