import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import { boardInputs } from '@/lib/automation-copy-server'
import { ghlAutomationStatus, pushAutomationValues } from '@/lib/ghl-automation-values'

/**
 * GET  /api/automation-copy/:id/ghl — read-only check of the client's GHL
 *      sub-account: which key can reach it, its custom values next to the
 *      board's details, and its workflow names.
 * POST — write the board's details as custom values. Body { values } (the
 *      board as shown, so an edit still waiting to save isn't lost).
 */

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied
  const { id } = await params
  const inputs = await boardInputs(id)
  if (!inputs) return NextResponse.json({ error: 'client not found' }, { status: 404 })
  return NextResponse.json(await ghlAutomationStatus(id, inputs))
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied
  const { id } = await params
  const body = (await req.json().catch(() => ({}))) as { values?: unknown }
  const inputs = await boardInputs(id, body.values)
  if (!inputs) return NextResponse.json({ error: 'client not found' }, { status: 404 })
  return NextResponse.json(await pushAutomationValues(id, inputs))
}
