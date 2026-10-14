import { NextRequest } from 'next/server'
import { withOwnerApi, externalOptions } from '@/lib/external-api'
import { recordExtensionOutcome } from '@/lib/ghl-subaccount-provisioning'

/**
 * POST /api/external/v1/ghl-subaccounts/report
 * { clientId, status: 'created' | 'failed' | 'skipped', locationId?, detail? }
 *
 * The extension's result for one client. "created" links the new
 * sub-account to the client (by id when the extension read it off the
 * page, else by the exact name); "failed" shows on the client card and
 * in Slack with the step that went wrong.
 */
export const POST = withOwnerApi(async (req) => {
  const body = (await req.json().catch(() => ({}))) as { clientId?: unknown; status?: unknown; locationId?: unknown; detail?: unknown }
  if (typeof body.clientId !== 'string' || !body.clientId) throw new Error('clientId is required')
  const status = body.status === 'created' || body.status === 'failed' || body.status === 'skipped' ? body.status : null
  if (!status) throw new Error('status must be created, failed or skipped')
  return recordExtensionOutcome(body.clientId, {
    status,
    locationId: typeof body.locationId === 'string' ? body.locationId : null,
    detail: typeof body.detail === 'string' ? body.detail : null,
  })
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
