import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { hlAccountOr404, hlGuard } from '@/lib/hl/http'

type Ctx = { params: Promise<{ id: string }> }

const PAGE = 50

/**
 * GET ?kind=product&q=&page=: the lists imported from GHL (src/lib/hl/ghl-import.ts):
 * staff, tags, custom fields and values, funnels, websites, media, products,
 * invoices, orders, transactions, subscriptions, coupons, trigger links,
 * snippets, companies, surveys. kind may be a comma list.
 */
export async function GET(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  const sp = new URL(req.url).searchParams
  const kinds = (sp.get('kind') ?? '').split(',').map((k) => k.trim()).filter(Boolean)
  if (!kinds.length) return NextResponse.json({ error: 'kind is required' }, { status: 400 })
  const q = (sp.get('q') ?? '').trim()
  const page = Math.max(0, Number(sp.get('page')) || 0)
  const where: Prisma.HlRecordWhereInput = { accountId: id, kind: { in: kinds }, ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}) }
  const [records, total] = await Promise.all([
    prisma.hlRecord.findMany({ where, orderBy: [{ name: 'asc' }], skip: page * PAGE, take: PAGE }),
    prisma.hlRecord.count({ where }),
  ])
  return NextResponse.json({ records, total, page, pageSize: PAGE })
}
