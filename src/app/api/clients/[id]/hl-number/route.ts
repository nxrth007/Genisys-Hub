import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { requireAdmin, requireStaff } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'
import { buyNumberNow } from '@/lib/hl/folder-actions'
import { askForClientNumber } from '@/lib/hl/number-request'

/**
 * GET /api/clients/:id/hl-number — this client's Hell-level toll-free number
 * request (status, number, where calls ring, why verification is blocked).
 *
 * POST { action: 'buy' } — admin only: their Sites folder's Buy toll-free
 * number, the same as Yes (Hell-level) on Echo's question in the Office:
 * bought now on Genisys's Twilio (about $2.15/month), calls pointed at their
 * business phone. Echo's open question is answered; otherwise it's asked and
 * answered at once. Not for a client whose GHL sub-account has a number.
 *
 * POST { action: 'ask' } — admin only: put Echo's question in the Office for
 * this client by hand (older clients, or after a No). Nothing is bought until
 * someone answers Yes there.
 */
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied
  const { id } = await params
  const request = await prisma.hlNumberRequest.findUnique({
    where: { clientId: id },
    select: { id: true, status: true, number: true, forwardTo: true, verifyNote: true, detail: true, trigger: true, decidedBy: true, decidedAt: true, log: true, updatedAt: true },
  })
  return NextResponse.json({ request })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin()
  if (denied) return denied
  const body = (await req.json().catch(() => null)) as { action?: unknown; overrideGhl?: unknown } | null
  const { id } = await params
  if (body?.action === 'buy') {
    const session = await auth()
    const res = await buyNumberNow(id, session?.user?.name || session?.user?.email || 'an admin')
    return NextResponse.json(res, { status: res.ok ? 200 : 409 })
  }
  if (body?.action !== 'ask') return NextResponse.json({ error: 'send { "action": "buy" } or { "action": "ask" }' }, { status: 400 })
  // overrideGhl: ask even though their GHL sub-account already has a number (a test, or moving them off GHL).
  const res = await askForClientNumber(id, 'manual', { overrideGhl: body.overrideGhl === true })
  return NextResponse.json(res, { status: res.ok ? 200 : 409 })
}
