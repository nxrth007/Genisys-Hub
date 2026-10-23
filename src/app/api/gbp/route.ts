import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import { gbpOverview } from '@/lib/gbp-setup'

/** GET /api/gbp — every active client's Google Business Profile standing, A–Z, for the Google Profiles tab. */
export async function GET() {
  const denied = await requireStaff()
  if (denied) return denied
  return NextResponse.json({ clients: await gbpOverview() })
}
