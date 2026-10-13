import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-helpers'
import {
  getGhlSubaccountSettings,
  recentGhlProvisioning,
  updateGhlSubaccountSettings,
} from '@/lib/ghl-subaccount-provisioning'

/**
 * GET / PATCH /api/admin/ghl-subaccounts
 *
 * Settings for creating a GHL sub-account for each new onboarding
 * client, plus the latest attempts. Admin-only: these create real
 * sub-accounts in the agency.
 *
 * PATCH body: { enabled?: boolean, snapshotId?: string }
 */
export async function GET() {
  const denial = await requireAdmin()
  if (denial) return denial

  const [settings, recent] = await Promise.all([getGhlSubaccountSettings(), recentGhlProvisioning()])
  return NextResponse.json({ settings, recent })
}

export async function PATCH(req: Request) {
  const denial = await requireAdmin()
  if (denial) return denial

  let body: { enabled?: unknown; snapshotId?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 })
  }
  if (
    body.snapshotId !== undefined &&
    (typeof body.snapshotId !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(body.snapshotId.trim()))
  ) {
    return NextResponse.json({ error: 'snapshotId must be a GHL snapshot ID' }, { status: 400 })
  }

  const settings = await updateGhlSubaccountSettings({
    enabled: body.enabled as boolean | undefined,
    snapshotId: body.snapshotId as string | undefined,
  })
  return NextResponse.json({ ok: true, settings })
}
