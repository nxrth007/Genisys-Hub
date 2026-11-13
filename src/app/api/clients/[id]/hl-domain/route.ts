import { NextResponse } from 'next/server'
import { requireAdmin, requireStaff } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'
import { askForClientDomain } from '@/lib/hl/domain-request'

/**
 * GET /api/clients/:id/hl-domain — this client's domain question (status,
 * the suggestions, what was bought).
 *
 * POST { action: 'ask' } — admin only: put Forge's question (three domains
 * to buy on Porkbun) in the Office for this client by hand: an older client,
 * or after a None of these. Nothing is bought until someone picks one there.
 */
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied
  const { id } = await params
  const request = await prisma.hlDomainRequest.findUnique({
    where: { clientId: id },
    select: { id: true, status: true, suggestions: true, name: true, costCents: true, detail: true, trigger: true, decidedBy: true, decidedAt: true, log: true, updatedAt: true },
  })
  return NextResponse.json({ request })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin()
  if (denied) return denied
  const body = (await req.json().catch(() => null)) as { action?: unknown } | null
  if (body?.action !== 'ask') return NextResponse.json({ error: 'send { "action": "ask" }' }, { status: 400 })
  const { id } = await params
  const res = await askForClientDomain(id, 'manual')
  return NextResponse.json(res, { status: res.ok ? 200 : 409 })
}
