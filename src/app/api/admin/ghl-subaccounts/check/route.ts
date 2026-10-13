import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-helpers'
import { checkGhlConnection } from '@/lib/ghl-subaccount-provisioning'

/**
 * POST /api/admin/ghl-subaccounts/check
 *
 * Read-only check of the "GHL Agency Key": which agency it acts for,
 * whether the configured snapshot is visible, and the newest
 * sub-accounts' names. The key itself never leaves the server.
 */
export async function POST() {
  const denial = await requireAdmin()
  if (denial) return denial

  return NextResponse.json(await checkGhlConnection())
}
