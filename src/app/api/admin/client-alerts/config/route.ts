import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireStaff } from '@/lib/auth-helpers'
import { backfillClientAlerts } from '@/lib/client-alert'

/**
 * GET / PATCH /api/admin/client-alerts/config
 *
 * Singleton config row for Client Alerts. Mirror of how the reminders
 * config is exposed — admin-only, idempotent upsert keyed to id
 * "singleton" so there's never a question of which row to update.
 *
 * PATCH body (all fields optional):
 *   {
 *     enabled?: boolean
 *     vaultEntryName?: string  // GHL token name in the vault
 *     senderPhone?: string | null  // E.164 sender override
 *   }
 *
 * Side-effect on first-enable (off → on): runs backfillClientAlerts
 * for every active client that has a contactPhone configured, so
 * historical sheet rows are recorded as 'backfilled' instead of
 * blasting SMS to clients on the next cron tick.
 */
function normalizePhoneForKey(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = String(raw).replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length >= 10) return `+${digits}`
  return null
}

export async function GET() {
  const denial = await requireStaff()
  if (denial) return denial

  const config = await prisma.clientAlertsConfig.upsert({
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
    vaultEntryName?: unknown
    senderPhone?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const data: Record<string, unknown> = {}
  if (typeof body.enabled === 'boolean') data.enabled = body.enabled
  if (typeof body.vaultEntryName === 'string' && body.vaultEntryName.trim()) {
    data.vaultEntryName = body.vaultEntryName.trim()
  }
  if (body.senderPhone === null) {
    data.senderPhone = null
  } else if (typeof body.senderPhone === 'string') {
    const trimmed = body.senderPhone.trim()
    data.senderPhone = trimmed.length > 0 ? trimmed : null
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json(
      { error: 'no recognized fields to update' },
      { status: 400 },
    )
  }

  const prior = await prisma.clientAlertsConfig.upsert({
    where: { id: 'singleton' },
    create: {},
    update: {},
  })
  const isFirstEnable = data.enabled === true && !prior.enabled

  const config = await prisma.clientAlertsConfig.update({
    where: { id: 'singleton' },
    data,
  })

  // First-enable backfill — only runs when the toggle actually flipped
  // off → on. Marks every historical sheet row for every client with
  // a phone as 'backfilled' so the next cron tick doesn't blast them.
  let backfill: { client: string; recorded: number; alreadyTracked: number }[] | null = null
  if (isFirstEnable) {
    backfill = []
    const clients = await prisma.client.findMany({
      where: { active: true },
      select: { id: true, name: true, contactPhone: true },
    })
    for (const c of clients) {
      const phone = normalizePhoneForKey(c.contactPhone)
      if (!phone) continue
      try {
        const result = await backfillClientAlerts({
          clientId: c.id,
          recipientPhone: phone,
        })
        backfill.push({ client: c.name, ...result })
      } catch (err) {
        console.error(
          `[client-alerts config] backfill for ${c.name} failed:`,
          err,
        )
      }
    }
  }

  return NextResponse.json({ config, backfill })
}
