import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { requireAdmin, requireStaff } from '@/lib/auth-helpers'
import { createEntry, getSecretByName } from '@/lib/vault-service'
import { LEAD_WEBHOOK_SECRET_ENTRY, leadAlertsOverview } from '@/lib/lead-alert'
import { installLeadAlertWorkflow, sweepLeadAlertInstalls } from '@/lib/lead-alert-install'
import { getAgencyContext, listSnapshots } from '@/lib/ghl-agency'

/**
 * GET    /api/admin/lead-alerts — overview for Settings → Lead texts (staff).
 *        The webhook URL carries the secret, so only admins get it.
 *        ?snapshots=1 lists the agency's snapshots instead.
 * PATCH  { enabled?: boolean, snapshotId?: string | null } (staff). A new
 *        snapshot starts loading into No EIN sub-accounts straight away.
 * POST   { action: 'create-secret' } — creates the Vault entry the webhook
 *        checks, if it doesn't exist yet (admin).
 *        { action: 'install', clientId } — load the snapshot into that
 *        client's sub-account now, even if it was done before (staff).
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

export async function GET(req: NextRequest) {
  const denial = await requireStaff()
  if (denial) return denial
  if (req.nextUrl.searchParams.get('snapshots') === '1') {
    try {
      return NextResponse.json({ snapshots: await listSnapshots(await getAgencyContext()) })
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 })
    }
  }
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
  const body = (await req.json().catch(() => ({}))) as { enabled?: unknown; snapshotId?: unknown }
  const data: { leadAlertsEnabled?: boolean; leadAlertSnapshotId?: string | null } = {}
  if (typeof body.enabled === 'boolean') data.leadAlertsEnabled = body.enabled
  if (body.snapshotId === null || typeof body.snapshotId === 'string') {
    data.leadAlertSnapshotId = typeof body.snapshotId === 'string' && body.snapshotId.trim() ? body.snapshotId.trim() : null
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
  }
  await prisma.clientAlertsConfig.upsert({ where: { id: 'singleton' }, create: data, update: data })
  if (data.leadAlertSnapshotId) {
    void sweepLeadAlertInstalls().catch((err) => console.warn('[lead-alerts] install sweep failed:', err))
  }
  return NextResponse.json({ ok: true })
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { action?: unknown; clientId?: unknown }

  if (body.action === 'install') {
    const denial = await requireStaff()
    if (denial) return denial
    if (typeof body.clientId !== 'string') return NextResponse.json({ error: 'clientId required' }, { status: 400 })
    return NextResponse.json(await installLeadAlertWorkflow(body.clientId, { force: true }))
  }

  if (body.action !== 'create-secret') {
    return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  }
  const denial = await requireAdmin()
  if (denial) return denial
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
