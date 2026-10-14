import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'
import { ghlSubAccountBoard, linkGhlSubAccount } from '@/lib/ghl-subaccount-provisioning'

/**
 * The by-hand sub-account board (src/lib/ghl-subaccount-provisioning.ts).
 *
 *   GET  → the board: the exact name and fields to type into GHL, the
 *          snapshot, where the client stands, and the steps ticked so far
 *   POST → link what was created: { locationId?: string } (a GHL link or
 *          id); without it, the Hub looks for the board's exact name
 *   PUT  → save the ticked steps: { checks: string[] }
 *
 * Staff (admin + member), like the A2P board.
 */

const STEP_IDS = new Set(['created', 'snapshot', 'checked'])
const keyFor = (id: string) => `ghlSubaccount.board.${id}`

async function savedChecks(id: string): Promise<string[]> {
  const row = await prisma.appSetting.findUnique({ where: { key: keyFor(id) } })
  try {
    const v = row ? (JSON.parse(row.value) as unknown) : []
    return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string' && STEP_IDS.has(c)) : []
  } catch {
    return []
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied
  const { id } = await params
  const board = await ghlSubAccountBoard(id)
  if (!board) return NextResponse.json({ error: 'client not found' }, { status: 404 })
  return NextResponse.json({ board, checks: await savedChecks(id) })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied
  const { id } = await params
  const body = (await req.json().catch(() => ({}))) as { locationId?: unknown }
  const result = await linkGhlSubAccount(id, { locationId: typeof body.locationId === 'string' ? body.locationId : null })
  return NextResponse.json(result, { status: result.ok || result.status === 'not_found' ? 200 : 502 })
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied
  const { id } = await params
  const body = (await req.json().catch(() => ({}))) as { checks?: unknown }
  const checks = Array.isArray(body.checks) ? body.checks.filter((c): c is string => typeof c === 'string' && STEP_IDS.has(c)) : []
  const exists = await prisma.client.findUnique({ where: { id }, select: { id: true } })
  if (!exists) return NextResponse.json({ error: 'client not found' }, { status: 404 })
  const value = JSON.stringify(checks)
  await prisma.appSetting.upsert({ where: { key: keyFor(id) }, create: { key: keyFor(id), value }, update: { value } })
  return NextResponse.json({ checks })
}
