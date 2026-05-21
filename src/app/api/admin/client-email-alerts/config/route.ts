import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireStaff } from '@/lib/auth-helpers'
import { backfillClientEmailAlerts } from '@/lib/client-email-alert'

/**
 * GET / PATCH /api/admin/client-email-alerts/config
 *
 * Singleton config for the Email Client Alerts feature. Mirror of
 * /api/admin/client-alerts/config (SMS) — admin-only, idempotent
 * upsert keyed to id "singleton". Per-client opt-in lives on
 * Client.emailAlertsEnabled and is managed via the sibling
 * /api/admin/client-email-alerts/clients endpoint.
 *
 * PATCH body (all optional):
 *   {
 *     enabled?: boolean
 *     fromGmailAccount?: string | null  // connected Gmail email
 *     senderName?: string | null        // From: display name
 *   }
 *
 * Side-effect on first-enable (off → on): runs backfillClientEmailAlerts
 * for every active client that has emailAlertsEnabled=true + a
 * contactEmail. Marks historical sheet rows as 'backfilled' so the
 * next cron tick doesn't blast clients with email for past bookings.
 */
function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed || !trimmed.includes('@')) return null
  return trimmed
}

export async function GET() {
  const denial = await requireStaff()
  if (denial) return denial

  const config = await prisma.clientEmailAlertsConfig.upsert({
    where: { id: 'singleton' },
    create: {},
    update: {},
  })
  return NextResponse.json({ config })
}

export async function PATCH(req: Request) {
  const denial = await requireStaff()
  if (denial) return denial

  let body: {
    enabled?: unknown
    fromGmailAccount?: unknown
    senderName?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const data: Record<string, unknown> = {}
  if (typeof body.enabled === 'boolean') data.enabled = body.enabled
  if (body.fromGmailAccount === null) {
    data.fromGmailAccount = null
  } else if (typeof body.fromGmailAccount === 'string') {
    const normalized = normalizeEmail(body.fromGmailAccount)
    data.fromGmailAccount = normalized
  }
  if (body.senderName === null) {
    data.senderName = null
  } else if (typeof body.senderName === 'string') {
    const trimmed = body.senderName.trim()
    data.senderName = trimmed.length > 0 ? trimmed : null
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json(
      { error: 'no recognized fields to update' },
      { status: 400 },
    )
  }

  const prior = await prisma.clientEmailAlertsConfig.upsert({
    where: { id: 'singleton' },
    create: {},
    update: {},
  })
  const isFirstEnable = data.enabled === true && !prior.enabled

  const config = await prisma.clientEmailAlertsConfig.update({
    where: { id: 'singleton' },
    data,
  })

  // First-enable backfill — only runs when the toggle flipped off → on.
  // Iterates over clients with emailAlertsEnabled=true + contactEmail
  // and marks historical sheet rows for each as 'backfilled' so the
  // next cron tick doesn't blast them with email for past bookings.
  let backfill: { client: string; recorded: number; alreadyTracked: number }[] | null = null
  if (isFirstEnable) {
    backfill = []
    const clients = await prisma.client.findMany({
      where: { active: true, emailAlertsEnabled: true },
      select: { id: true, name: true, contactEmail: true },
    })
    for (const c of clients) {
      const email = normalizeEmail(c.contactEmail)
      if (!email) continue
      try {
        const result = await backfillClientEmailAlerts({
          clientId: c.id,
          recipientEmail: email,
        })
        backfill.push({ client: c.name, ...result })
      } catch (err) {
        console.error(
          `[client-email-alerts config] backfill for ${c.name} failed:`,
          err,
        )
      }
    }
  }

  return NextResponse.json({ config, backfill })
}
