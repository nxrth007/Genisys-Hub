import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireStaff } from '@/lib/auth-helpers'
import { sendTestClientEmailAlert } from '@/lib/client-email-alert'

/**
 * POST /api/admin/client-email-alerts/test
 *
 * Sends a sample alert email to an arbitrary address using a fake
 * appointment. Used by Settings → "Test email" to smoke-test the
 * Gmail account + From: header rendering before flipping a real
 * client on.
 *
 * Body:
 *   {
 *     recipientEmail: string
 *     clientName?: string    // shown in the sample body ("Spring Solar")
 *     fromGmailAccount?: string  // override the config default
 *     senderName?: string | null
 *   }
 */
export async function POST(req: Request) {
  const denial = await requireStaff()
  if (denial) return denial

  let body: {
    recipientEmail?: unknown
    clientName?: unknown
    fromGmailAccount?: unknown
    senderName?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const recipientEmail =
    typeof body.recipientEmail === 'string' ? body.recipientEmail.trim() : ''
  if (!recipientEmail || !recipientEmail.includes('@')) {
    return NextResponse.json(
      { error: 'recipientEmail must be a valid email address' },
      { status: 400 },
    )
  }

  const clientName =
    (typeof body.clientName === 'string' && body.clientName.trim()) ||
    'Sample Client'

  // Resolve which Gmail account to send from. Body override wins, then
  // the singleton config, then env, then alex@. Validate it's a
  // connected account so we don't error opaquely on send.
  let fromGmailAccount: string
  if (typeof body.fromGmailAccount === 'string' && body.fromGmailAccount.trim()) {
    fromGmailAccount = body.fromGmailAccount.trim().toLowerCase()
  } else {
    const config = await prisma.clientEmailAlertsConfig.findUnique({
      where: { id: 'singleton' },
    })
    fromGmailAccount =
      config?.fromGmailAccount ||
      process.env.CLIENT_EMAIL_ALERT_FROM ||
      'alex@leadgenisys.com'
  }
  const connected = await prisma.gmailAccount.findUnique({
    where: { email: fromGmailAccount },
    select: { email: true },
  })
  if (!connected) {
    return NextResponse.json(
      {
        error: `${fromGmailAccount} isn't a connected Gmail account on this Hub. Connect it from Settings → Gmail accounts first.`,
      },
      { status: 400 },
    )
  }

  const senderName =
    body.senderName === null
      ? null
      : typeof body.senderName === 'string'
        ? body.senderName.trim() || null
        : null

  try {
    const result = await sendTestClientEmailAlert({
      fromGmailAccount,
      senderName,
      recipientEmail,
      clientName,
    })
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'send failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
