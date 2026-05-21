import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireStaff } from '@/lib/auth-helpers'
import { backfillClientEmailAlerts } from '@/lib/client-email-alert'

/**
 * GET  /api/admin/client-email-alerts/clients
 * PATCH /api/admin/client-email-alerts/clients
 *
 * Lists every active client with the fields the Settings UI needs to
 * render the per-client toggle row (id, name, color, contactEmail,
 * emailAlertsEnabled). Flipping a client to enabled=true triggers a
 * first-time-on backfill — mark every historical sheet row for that
 * client as 'backfilled' so the next cron tick doesn't blast email
 * for past bookings.
 *
 * PATCH body:
 *   { clientId: string, enabled: boolean }
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

  const clients = await prisma.client.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      state: true,
      color: true,
      contactEmail: true,
      emailAlertsEnabled: true,
    },
  })
  return NextResponse.json({ clients })
}

export async function PATCH(req: Request) {
  const denial = await requireStaff()
  if (denial) return denial

  let body: { clientId?: unknown; enabled?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const clientId = typeof body.clientId === 'string' ? body.clientId : ''
  if (!clientId) {
    return NextResponse.json({ error: 'clientId is required' }, { status: 400 })
  }
  if (typeof body.enabled !== 'boolean') {
    return NextResponse.json(
      { error: 'enabled must be a boolean' },
      { status: 400 },
    )
  }
  const enabled = body.enabled

  const existing = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      name: true,
      contactEmail: true,
      emailAlertsEnabled: true,
    },
  })
  if (!existing) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 })
  }

  // Soft warning: enabling a client without a contactEmail means the
  // cron will route the rows but skip them at send time. We still
  // accept the toggle (admin may be planning to fill in the email
  // next) but the response carries a `warning` field the UI can
  // surface.
  let warning: string | undefined
  if (enabled && !normalizeEmail(existing.contactEmail)) {
    warning = `${existing.name} has no contact email set — alerts will be queued + skipped at send time until you set one.`
  }

  const updated = await prisma.client.update({
    where: { id: clientId },
    data: { emailAlertsEnabled: enabled },
    select: {
      id: true,
      name: true,
      contactEmail: true,
      emailAlertsEnabled: true,
    },
  })

  // First-enable backfill for THIS client — only when the toggle
  // flipped off → on AND a contactEmail exists. Same pattern as the
  // SMS section's per-client backfill: mark every historical sheet
  // row for this client as 'backfilled' so the next cron tick
  // doesn't suddenly blast them with email.
  let backfill: { recorded: number; alreadyTracked: number } | null = null
  const flippedOn = enabled === true && existing.emailAlertsEnabled === false
  if (flippedOn) {
    const recipientEmail = normalizeEmail(existing.contactEmail)
    if (recipientEmail) {
      try {
        backfill = await backfillClientEmailAlerts({
          clientId: existing.id,
          recipientEmail,
        })
      } catch (err) {
        console.error(
          `[client-email-alerts clients] backfill for ${existing.name} failed:`,
          err,
        )
      }
    }
  }

  return NextResponse.json({ client: updated, backfill, warning })
}
