import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import {
  isClientWorkspaceProvisioningEnabled,
  setClientWorkspaceProvisioningEnabled,
} from '@/lib/client-workspace'

/**
 * GET / PATCH /api/admin/client-workspace-provisioning/config
 *
 * Master toggle for auto-creating a Slack channel + sending the
 * Slack Connect invite when admin approves a pending Client.
 *
 * Storage is the generic AppSetting KV row keyed
 * "clientWorkspaceProvisioning.enabled". Default-on if the row
 * doesn't exist, so behavior matches what shipped with the feature.
 *
 * PATCH body: { enabled: boolean }
 */
export async function GET() {
  const denial = await requireStaff()
  if (denial) return denial

  const enabled = await isClientWorkspaceProvisioningEnabled()
  return NextResponse.json({ enabled })
}

export async function PATCH(req: Request) {
  const denial = await requireStaff()
  if (denial) return denial

  let body: { enabled?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (typeof body.enabled !== 'boolean') {
    return NextResponse.json(
      { error: 'enabled must be a boolean' },
      { status: 400 },
    )
  }

  await setClientWorkspaceProvisioningEnabled(body.enabled)
  return NextResponse.json({ ok: true, enabled: body.enabled })
}
