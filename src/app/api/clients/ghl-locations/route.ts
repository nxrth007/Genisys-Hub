import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import { subAccountOptions } from '@/lib/ghl-subaccount-provisioning'

/** GET /api/clients/ghl-locations — every agency sub-account and the client it's linked to (staff). */
export async function GET() {
  const denied = await requireStaff()
  if (denied) return denied
  try {
    return NextResponse.json(await subAccountOptions())
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 })
  }
}
