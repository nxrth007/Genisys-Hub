import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireStaff } from '@/lib/auth-helpers'
import { sendTestClientAlert } from '@/lib/client-alert'

/**
 * POST /api/admin/client-alerts/test
 *
 * Send a sample SMS to a client's contactPhone using the current
 * Client Alerts config. Resolves the recipient from Client.contactPhone
 * + the GHL token + sender override automatically — admin doesn't have
 * to retype anything they've already configured.
 *
 * Body:
 *   { clientId: string }
 *
 * Returns the GHL message id so admin can grep the GHL conversation
 * thread to confirm delivery, or surface it back in the UI.
 */
export async function POST(req: Request) {
  const denial = await requireStaff()
  if (denial) return denial

  let body: { clientId?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const clientId =
    typeof body.clientId === 'string' ? body.clientId.trim() : ''
  if (!clientId) {
    return NextResponse.json(
      { error: 'clientId is required' },
      { status: 400 },
    )
  }

  const client = await prisma.client.findUnique({
    where: { id: clientId },
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

  const config = await prisma.clientAlertsConfig.upsert({
    where: { id: 'singleton' },
    create: {},
    update: {},
  })

  try {
    const result = await sendTestClientAlert({
      vaultEntryName: config.vaultEntryName,
      senderPhone: config.senderPhone,
      recipientPhone: client.contactPhone,
      clientName: client.name,
    })
    return NextResponse.json({
      ok: true,
      clientName: client.name,
      messageId: result.messageId,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Test SMS failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
