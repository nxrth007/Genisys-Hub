import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { requireAdmin } from '@/lib/auth-helpers'
import { advanceJourneyStage, getJourney } from '@/lib/client-journey'
import { linkGhlSubAccount } from '@/lib/ghl-subaccount-provisioning'

/**
 * POST /api/admin/client-journey/link-subaccount
 *
 * Link a GHL sub-account created by hand (the plan blocks API creation) to
 * a client: sets Client.ghlLocationId and marks the journey's subaccount
 * stage done (intake → subaccount → website moves on). The location is
 * checked against the agency first; an id already linked to another
 * client is refused.
 *
 * Body: { clientId: string, locationId: string (id or GHL link), replace?: boolean }
 */
export async function POST(req: Request) {
  const denial = await requireAdmin()
  if (denial) return denial
  const body = (await req.json().catch(() => null)) as { clientId?: unknown; locationId?: unknown; replace?: unknown } | null
  if (!body || typeof body.clientId !== 'string' || !body.clientId) return NextResponse.json({ error: 'clientId is required' }, { status: 400 })
  if (typeof body.locationId !== 'string' || !body.locationId.trim()) return NextResponse.json({ error: 'locationId is required' }, { status: 400 })
  const session = await auth()
  const result = await linkGhlSubAccount(body.clientId, {
    locationId: body.locationId.trim(),
    replace: body.replace === true,
    actor: session?.user?.id ?? null,
  })
  if (result.ok && result.status === 'already') {
    // Already linked before the journey existed: still move the stage on.
    await advanceJourneyStage(body.clientId, 'subaccount', { note: `Already linked to ${result.locationId}`, actor: session?.user?.id ?? null })
  }
  const status = result.ok ? 200 : result.status === 'not_found' ? 404 : result.reason === 'client not found' ? 404 : 502
  return NextResponse.json({ ...result, journey: result.ok ? await getJourney(body.clientId) : undefined }, { status })
}
