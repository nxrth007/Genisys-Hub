import { NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { requireAdmin, requireStaff } from '@/lib/auth-helpers'
import { createEntry, getSecretByName } from '@/lib/vault-service'
import { LEAD_WEBHOOK_SECRET_ENTRY, leadAlertsOverview } from '@/lib/lead-alert'

/**
 * GET    /api/admin/lead-alerts — overview for Settings → Lead texts (staff).
 *        The webhook URL carries the secret, so only admins get it.
 * PATCH  { enabled: boolean } — master switch (staff).
 * POST   { action: 'create-secret' } — creates the Vault entry the webhook
 *        checks, if it doesn't exist yet (admin).
 */

export const dynamic = 'force-dynamic'

const WEBHOOK_PATH = '/api/webhooks/ghl-lead'

async function webhookUrl(): Promise<{ configured: boolean; url: string | null }> {
  const secret = await getSecretByName(LEAD_WEBHOOK_SECRET_ENTRY)
    .then((v) => v.trim())
    .catch(() => '')
  if (!secret) return { configured: false, url: null }
  const base = (process.env.AUTH_URL || 'http://localhost:3000').replace(/\/+$/, '')
  return { configured: true, url: `${base}${WEBHOOK_PATH}?secret=${encodeURIComponent(secret)}` }
}

export async function GET() {
  const denial = await requireStaff()
  if (denial) return denial
  const session = await auth()
  const isAdmin = (session?.user as { role?: string } | undefined)?.role === 'admin'
  const [overview, hook] = await Promise.all([leadAlertsOverview(), webhookUrl()])
  return NextResponse.json({
    ...overview,
    secretConfigured: hook.configured,
    webhookUrl: isAdmin ? hook.url : null,
    isAdmin,
  })
}

export async function PATCH(req: Request) {
  const denial = await requireStaff()
  if (denial) return denial
  const body = (await req.json().catch(() => ({}))) as { enabled?: unknown }
  if (typeof body.enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled must be true or false' }, { status: 400 })
  }
  await prisma.clientAlertsConfig.upsert({
    where: { id: 'singleton' },
    create: { leadAlertsEnabled: body.enabled },
    update: { leadAlertsEnabled: body.enabled },
  })
  return NextResponse.json({ ok: true, enabled: body.enabled })
}

export async function POST(req: Request) {
  const denial = await requireAdmin()
  if (denial) return denial
  const body = (await req.json().catch(() => ({}))) as { action?: unknown }
  if (body.action !== 'create-secret') {
    return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  }
  const existing = await prisma.vaultEntry.findFirst({ where: { name: LEAD_WEBHOOK_SECRET_ENTRY }, select: { id: true } })
  if (!existing) {
    const session = await auth()
    await createEntry({
      name: LEAD_WEBHOOK_SECRET_ENTRY,
      description: 'Checked by /api/webhooks/ghl-lead. Changing it breaks every client sub-account workflow until their URLs are updated.',
      value: randomBytes(24).toString('base64url'),
      tags: ['webhook'],
      userId: session!.user!.id!,
    })
  }
  return NextResponse.json({ ok: true, ...(await webhookUrl()) })
}
