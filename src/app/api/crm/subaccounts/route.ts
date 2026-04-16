import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { listSubAccounts } from '@/lib/ghl'

/**
 * GET /api/crm/subaccounts
 * Auto-discovers all GHL sub-accounts from vault entries tagged "ghl".
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const subaccounts = await listSubAccounts()
    return NextResponse.json({ subaccounts })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list sub-accounts'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
