import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { resolveChannelIdByName, formatSlackError } from '@/lib/slack'

/**
 * GET /api/admin/diagnostics/client-message-alerts
 *
 * Quick health check for the inbound-client-message Slack alert
 * pipeline. Hit this from the browser as admin to verify:
 *   - The configured channel name (env override OR default)
 *   - Whether the bot can resolve that channel to an ID
 *   - How many alerts the ledger has tracked (and whether backfill
 *     has run yet)
 *   - The 5 most recent alerts with their Slack permalinks
 *
 * No side effects — purely a read. Admin / member only (matches
 * the rest of /api/admin gating).
 */
const DEFAULT_CHANNEL_NAME =
  process.env.SLACK_CLIENT_MESSAGE_ALERTS_CHANNEL || 'genisys-alerts'

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Resolve the channel. Failure modes are distinct so the response
  // can tell admin exactly what to fix:
  //   - resolved   = channel exists, bot is a member
  //   - notFound   = channel doesn't exist OR bot isn't a member
  //                  (Slack's conversations.list only returns
  //                  channels the bot is in, so the two cases are
  //                  indistinguishable from our side)
  //   - error      = Slack API error (token missing, rate limit, etc.)
  let channelId: string | null = null
  let channelStatus: 'resolved' | 'notFound' | 'error' = 'notFound'
  let channelError: string | null = null
  try {
    channelId = await resolveChannelIdByName(DEFAULT_CHANNEL_NAME)
    channelStatus = channelId ? 'resolved' : 'notFound'
  } catch (err) {
    channelStatus = 'error'
    channelError = formatSlackError(err)
  }

  const [ledgerCount, recent] = await Promise.all([
    prisma.clientMessageAlert.count(),
    prisma.clientMessageAlert.findMany({
      orderBy: { alertedAt: 'desc' },
      take: 5,
      select: {
        id: true,
        conversationId: true,
        clientId: true,
        lastMessageId: true,
        lastMessageDate: true,
        slackChannelId: true,
        slackMessageTs: true,
        permalink: true,
        alertedAt: true,
        client: {
          select: { name: true, contactName: true },
        },
      },
    }),
  ])

  // Distinguish "haven't synced yet / nothing to backfill" from
  // "backfill ran cleanly" so admin doesn't have to guess.
  const hint =
    channelStatus !== 'resolved'
      ? `Channel "${DEFAULT_CHANNEL_NAME}" not found from the bot's view. Make sure the bot is a member of #${DEFAULT_CHANNEL_NAME} (/invite @bot in the channel) and that "Slack Bot Token" is in the vault.`
      : ledgerCount === 0
        ? `Channel resolved fine. Ledger is empty — either no inbound client messages have happened yet, or the first cron tick hasn't run since the deploy. Backfill (no Slack post) runs on the very first tick when the ledger is empty.`
        : `Channel resolved + ledger populated. Real-time alerts will fire on each new inbound from a registered client.`

  return NextResponse.json({
    channelName: DEFAULT_CHANNEL_NAME,
    channelStatus,
    channelId,
    channelError,
    ledgerCount,
    recent: recent.map((r) => ({
      ...r,
      contact:
        r.client?.contactName?.trim() || r.client?.name || '(orphaned)',
      business: r.client?.name ?? null,
    })),
    hint,
  })
}
