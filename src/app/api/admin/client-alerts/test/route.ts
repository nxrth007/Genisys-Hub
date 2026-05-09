import { NextResponse, type NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { auth } from '@/auth'
import { sendTestClientAlert } from '@/lib/client-alert'
import { checkRateLimit } from '@/lib/rate-limit'

/**
 * POST /api/admin/client-alerts/test
 *
 * Send a sample SMS using the current Client Alerts config. Two modes:
 *
 *   { clientId: string }
 *     Resolves recipient + label from the Client record (existing
 *     "Send test SMS" buttons in the per-client list). Lower risk —
 *     the recipient is a vetted client phone, not arbitrary input.
 *
 *   { recipientPhone: string, label?: string, confirm: true }
 *     Direct send to an arbitrary number — for "test to my own
 *     phone" smoke tests before any client has been configured. The
 *     `label` field substitutes into the body where the client name
 *     would normally appear; defaults to "Test recipient". Requires
 *     an explicit `confirm: true` flag in the body so a stale-cookie
 *     replay can't fire SMS to attacker-chosen numbers.
 *
 * GHL token + sender override come from the singleton config either
 * way, so admin never re-types vault entries.
 *
 * Auth: admin role only (this endpoint can spend money and contact
 * arbitrary phones, so even Ethan-as-member shouldn't be able to fire
 * it without elevation). Rate-limited per user at 10/hour to cap
 * blast-radius if a session is stolen or a UI bug starts looping.
 */
const RATE_LIMIT_MAX = 10
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000 // 1 hour

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string }).role
  if (role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const limit = checkRateLimit(
    `client-alerts-test:${session.user.id}`,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
  )
  if (!limit.ok) {
    const retryAfterSec = Math.ceil(limit.retryAfterMs / 1000)
    return NextResponse.json(
      {
        error: `Too many test sends — try again in ${retryAfterSec}s. (Limit: ${RATE_LIMIT_MAX}/hour.)`,
      },
      { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
    )
  }

  let body: {
    clientId?: unknown
    recipientPhone?: unknown
    label?: unknown
    confirm?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const config = await prisma.clientAlertsConfig.upsert({
    where: { id: 'singleton' },
    create: {},
    update: {},
  })

  let recipientPhone: string
  let label: string

  if (typeof body.clientId === 'string' && body.clientId.trim()) {
    const client = await prisma.client.findUnique({
      where: { id: body.clientId.trim() },
      select: { id: true, name: true, contactPhone: true },
    })
    if (!client) {
      return NextResponse.json({ error: 'client not found' }, { status: 404 })
    }
    if (!client.contactPhone) {
      return NextResponse.json(
        {
          error: `${client.name} has no contactPhone set. Add one in /clients before testing.`,
        },
        { status: 400 },
      )
    }
    recipientPhone = client.contactPhone
    label = client.name
  } else if (
    typeof body.recipientPhone === 'string' &&
    body.recipientPhone.trim()
  ) {
    // Direct-recipient mode requires an explicit confirm flag — the
    // UI surfaces a confirm() dialog before submitting; this server
    // check makes that contract unspoofable from a stale cookie.
    if (body.confirm !== true) {
      return NextResponse.json(
        {
          error:
            'direct-recipient test requires { confirm: true } — guard against accidental sends',
        },
        { status: 400 },
      )
    }
    recipientPhone = body.recipientPhone.trim()
    label =
      typeof body.label === 'string' && body.label.trim()
        ? body.label.trim()
        : 'Test recipient'
  } else {
    return NextResponse.json(
      {
        error:
          'pass either { clientId } to test a configured client, or { recipientPhone, confirm: true } to send to an arbitrary number',
      },
      { status: 400 },
    )
  }

  try {
    const result = await sendTestClientAlert({
      vaultEntryName: config.vaultEntryName,
      senderPhone: config.senderPhone,
      recipientPhone,
      clientName: label,
    })
    return NextResponse.json({
      ok: true,
      clientName: label,
      recipientPhone,
      messageId: result.messageId,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Test SMS failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
