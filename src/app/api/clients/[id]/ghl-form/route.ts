import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { requireAdmin } from '@/lib/auth-helpers'
import { queueFormFix } from '@/lib/ghl-form/queue'

/**
 * POST /api/clients/:id/ghl-form { action: 'fix' } — make the snapshot's site
 * form this client's own in GHL (src/lib/ghl-form): their name in the consent
 * checkboxes, and an older sub-account's A Plus logo and policy links gone.
 * Admin only, since it changes their GHL sub-account.
 */
export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin()
  if (denied) return denied
  const body = (await req.json().catch(() => null)) as { action?: unknown } | null
  if (body?.action !== 'fix') return NextResponse.json({ error: 'send { "action": "fix" }' }, { status: 400 })
  const { id } = await params
  const session = await auth()
  const by = session?.user?.name || session?.user?.email || 'an admin'
  const res = await queueFormFix(id, { trigger: 'manual', by })
  if (!res.ok) return NextResponse.json({ error: res.reason }, { status: 409 })
  return NextResponse.json(res)
}
