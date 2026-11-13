import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { requireAdmin, requireStaff, type SessionUserShape } from '@/lib/auth-helpers'
import { askForNumber, numberView, startNumberNow } from '@/lib/ghl-number/queue'

/**
 * GET /api/clients/:id/ghl-number — where this client's toll-free number
 * stands: the job (bought number, where its calls ring, log, screenshots)
 * and whether new sub-accounts get asked about automatically.
 *
 * POST { action: 'ask' } — put the question in the Office for an admin's Yes.
 * POST { action: 'buy' } — admin only: buy and move it now (the press is the
 * approval).
 */
export const dynamic = 'force-dynamic'

async function role(): Promise<string | undefined> {
  const session = await auth()
  return (session?.user as SessionUserShape | undefined)?.role
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied
  const { id } = await params
  const view = await numberView(id)
  if (!view) return NextResponse.json({ error: 'client not found' }, { status: 404 })
  return NextResponse.json({ ...view, canBuy: (await role()) === 'admin' })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const body = (await req.json().catch(() => null)) as { action?: unknown } | null
  const action = body?.action
  if (action !== 'ask' && action !== 'buy') return NextResponse.json({ error: 'send { "action": "ask" } or { "action": "buy" }' }, { status: 400 })
  const denied = action === 'buy' ? await requireAdmin() : await requireStaff()
  if (denied) return denied
  const { id } = await params
  const session = await auth()
  const by = session?.user?.name || session?.user?.email || 'staff'
  const result = action === 'buy' ? await startNumberNow(id, by) : await askForNumber(id, 'manual')
  const view = await numberView(id)
  return NextResponse.json(
    { result, view: view ? { ...view, canBuy: (session?.user as SessionUserShape | undefined)?.role === 'admin' } : null },
    { status: result.ok ? 200 : 409 },
  )
}
