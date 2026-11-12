import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-helpers'
import { recheckSnapshotLocation } from '@/lib/ghl-subaccount-worker/queue'
import { prisma } from '@/lib/prisma'

/**
 * POST /api/admin/ghl-subaccount-worker/recheck
 * { clientId }
 *
 * Re-reads GHL's last snapshot push for this client's location and
 * screenshots the location snapshot page. It does not create a
 * sub-account and it does not press Load snapshot.
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
  if (typeof body.clientId !== 'string' || !body.clientId.trim()) {
    return NextResponse.json({ error: 'clientId is required' }, { status: 400 })
  }
  const client = await prisma.client.findUnique({
    where: { id: body.clientId.trim() },
    select: { ghlLocationId: true },
  })
  if (!client?.ghlLocationId) {
    return NextResponse.json({ error: 'This client has no GHL location to recheck.' }, { status: 400 })
  }
  const detail = await recheckSnapshotLocation(client.ghlLocationId)
  return NextResponse.json({ ok: true, locationId: client.ghlLocationId, detail })
}
