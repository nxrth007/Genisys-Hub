import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { listConnectedAccounts, disconnectAccount } from '@/lib/drive'

/**
 * GET /api/drive/accounts — list connected Drive accounts.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const accounts = await listConnectedAccounts()
  return NextResponse.json({ accounts })
}

/**
 * DELETE /api/drive/accounts?email=alex@leadgenisys.com
 * Disconnects an account (removes stored tokens).
 */
export async function DELETE(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const email = req.nextUrl.searchParams.get('email')
  if (!email) {
    return NextResponse.json({ error: 'email query required' }, { status: 400 })
  }
  try {
    await disconnectAccount(email)
    return NextResponse.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to disconnect'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
