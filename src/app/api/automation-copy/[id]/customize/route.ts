import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import { customizeView, queueCustomize } from '@/lib/ghl-customize/queue'

/**
 * GET /api/automation-copy/:id/customize — where putting this client's copy
 * into their GHL Incoming Lead workflows stands (the job, its log, its
 * screenshots, and whether automatic runs are on).
 *
 * POST — "Customize now": queue it for this client right away. Only needs a
 * linked sub-account; a blank detail holds it instead.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied
  const { id } = await params
  const view = await customizeView(id)
  if (!view) return NextResponse.json({ error: 'client not found' }, { status: 404 })
  return NextResponse.json(view)
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied
  const { id } = await params
  const res = await queueCustomize(id, { trigger: 'manual', force: true })
  const view = await customizeView(id)
  return NextResponse.json({ result: res, view }, { status: res.ok || res.status === 'held' ? 200 : res.status === 'failed' ? 404 : 409 })
}
