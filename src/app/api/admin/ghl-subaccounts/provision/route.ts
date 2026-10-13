import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-helpers'
import { provisionGhlSubAccount } from '@/lib/ghl-subaccount-provisioning'

/**
 * POST /api/admin/ghl-subaccounts/provision
 *
 * Retry a client's sub-account after a failed (or stuck) attempt, or
 * create one the automation skipped.
 * Links a sub-account with the same name instead of creating a second.
 *
 * Body: { clientId: string }
 */
export async function POST(req: Request) {
  const denial = await requireAdmin()
  if (denial) return denial

  let body: { clientId?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (typeof body.clientId !== 'string' || !body.clientId) {
    return NextResponse.json({ error: 'clientId is required' }, { status: 400 })
  }

  const result = await provisionGhlSubAccount(body.clientId, { manual: true })
  return NextResponse.json(result, { status: result.ok || result.status === 'skipped' ? 200 : 502 })
}
