import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET  /api/admin/ppa-invoicing/settings  → current enabled state
 * POST /api/admin/ppa-invoicing/settings  → { enabled: boolean }
 *
 * Backs the PPA invoicing toggle on /settings. Stored in
 * AppSetting under the 'ppaInvoicing.enabled' key so flipping the
 * value doesn't require a deploy and survives restarts. Env var
 * PPA_INVOICING_DISABLED still wins — it's the hard kill switch
 * for incidents; this UI toggle is the everyday on/off.
 *
 * Admin-only — non-admin sessions get 403 to prevent a member /
 * agent from pausing client billing.
 */

const KEY = 'ppaInvoicing.enabled'

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const setting = await prisma.appSetting.findUnique({ where: { key: KEY } })
  // Default enabled. The migration doesn't seed this row, so a
  // fresh deploy without a manual flip is in "enabled" state.
  const enabled = setting?.value !== 'false'

  // Surface the env-var override status too so the UI can show a
  // banner when the env var is forcing things off (otherwise the
  // toggle would look broken).
  const envOverride =
    (process.env.PPA_INVOICING_DISABLED || '').toLowerCase() === 'true'

  return NextResponse.json({ enabled, envOverride })
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  // Admin only for the write — invoice automation impacts revenue,
  // so we don't let a member role disable it.
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: { enabled?: unknown }
  try {
    body = (await req.json()) as { enabled?: unknown }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (typeof body.enabled !== 'boolean') {
    return NextResponse.json(
      { error: '`enabled` must be a boolean' },
      { status: 400 },
    )
  }

  await prisma.appSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: body.enabled ? 'true' : 'false' },
    update: { value: body.enabled ? 'true' : 'false' },
  })

  console.log(
    `[ppa-invoicing] toggled to ${body.enabled ? 'enabled' : 'disabled'} by user ${session.user.id}`,
  )

  return NextResponse.json({ ok: true, enabled: body.enabled })
}
