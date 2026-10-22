import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { requireStaff } from '@/lib/auth-helpers'
import { matchVaultKeys } from '@/lib/ghl-key-matching'

/**
 * POST /api/automation-copy/match-keys — find which client sub-account each
 * unplaced GHL key in the Vault belongs to (by asking GHL) and record it on
 * the entry: locationId/client in the description and the `client` tag.
 */
export async function POST() {
  const denied = await requireStaff()
  if (denied) return denied
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json(await matchVaultKeys(userId))
}
