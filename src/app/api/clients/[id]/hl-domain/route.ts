import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { requireAdmin, requireStaff } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'
import { buyDomainNow, dropDomainsNow, suggestDomainsNow } from '@/lib/hl/folder-actions'
import { askForClientDomain } from '@/lib/hl/domain-request'

/**
 * GET /api/clients/:id/hl-domain — this client's domain question (status,
 * the suggestions, what was bought).
 *
 * From their Sites folder (admin only), the same as Forge's question in the
 * Office:
 * - POST { action: 'suggest' } — three available domains from Porkbun for
 *   the business name, with Porkbun's all-in first-year price (free: an
 *   availability check and a dry run). It is Forge's question in the Office
 *   too; an open one gets fresh suggestions.
 * - POST { action: 'buy', name } — buys that suggestion on Porkbun at the
 *   price shown (re-quoted: that price or nothing, never twice), into their
 *   Hell-level → Domains.
 * - POST { action: 'none' } — None of these.
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
  const body = (await req.json().catch(() => null)) as { action?: unknown; name?: unknown } | null
  const { id } = await params
  const session = await auth()
  const by = session?.user?.name || session?.user?.email || 'an admin'
  if (body?.action === 'suggest') {
    const res = await suggestDomainsNow(id)
    return NextResponse.json(res, { status: res.ok ? 200 : 409 })
  }
  if (body?.action === 'buy') {
    const name = typeof body.name === 'string' ? body.name.trim().toLowerCase() : ''
    if (!name) return NextResponse.json({ ok: false, reason: 'Say which domain to buy.' }, { status: 400 })
    const res = await buyDomainNow(id, name, by)
    return NextResponse.json(res, { status: res.ok ? 200 : 409 })
  }
  if (body?.action === 'none') {
    const res = await dropDomainsNow(id, by)
    return NextResponse.json(res, { status: res.ok ? 200 : 409 })
  }
  if (body?.action !== 'ask') return NextResponse.json({ error: 'send { "action": "suggest" }, { "action": "buy", "name": "acme.com" }, { "action": "none" } or { "action": "ask" }' }, { status: 400 })
  const res = await askForClientDomain(id, 'manual')
  return NextResponse.json(res, { status: res.ok ? 200 : 409 })
}
