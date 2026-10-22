import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import { ghlAutomationOverview } from '@/lib/ghl-automation-overview'

/** GET /api/automation-copy/ghl-overview — every client's GHL link, key and custom values, for the list page. Read-only. */
export async function GET() {
  const denied = await requireStaff()
  if (denied) return denied
  return NextResponse.json(await ghlAutomationOverview())
}
