import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireStaff } from '@/lib/auth-helpers'
import { sendTestClientAlert } from '@/lib/client-alert'

/**
 * POST /api/admin/client-alerts/test
 *
 * Send a sample SMS using the current Client Alerts config. Two modes:
 *
 *   { clientId: string }
 *     Resolves recipient + label from the Client record (existing
 *     "Send test SMS" buttons in the per-client list).
 *
 *   { recipientPhone: string, label?: string }
 *     Direct send to an arbitrary number — for "test to my own
 *     phone" smoke tests before any client has been configured. The
 *     `label` field substitutes into the body where the client name
 *     would normally appear; defaults to "Test recipient".
 *
 * GHL token + sender override come from the singleton config either
 * way, so admin never re-types vault entries.
 */
export async function POST(req: Request) {
  const denial = await requireStaff()
  if (denial) return denial

  let body: { clientId?: unknown; recipientPhone?: unknown; label?: unknown }
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
    recipientPhone = body.recipientPhone.trim()
    label =
      typeof body.label === 'string' && body.label.trim()
        ? body.label.trim()
        : 'Test recipient'
  } else {
    return NextResponse.json(
      {
        error:
          'pass either { clientId } to test a configured client, or { recipientPhone } to send to an arbitrary number',
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
