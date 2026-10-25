import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { hlAccountOr404, hlAccountGuard } from '@/lib/hl/http'

type Ctx = { params: Promise<{ id: string }> }

/** GET ?filter=unread|all&q=: conversations (contacts with any activity), most recent first. */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params
  const guard = await hlAccountGuard(id)
  if (guard instanceof NextResponse) return guard
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  const sp = new URL(req.url).searchParams
  const q = (sp.get('q') ?? '').trim()
  const digits = q.replace(/\D/g, '')
  const where: Prisma.HlContactWhereInput = {
    accountId: id,
    lastMessageAt: { not: null },
    ...(sp.get('filter') === 'unread' ? { unread: { gt: 0 } } : {}),
    ...(sp.get('filter') === 'starred' ? { starred: true } : {}),
    ...(sp.get('filter') === 'recents' ? { lastMessageAt: { gte: new Date(Date.now() - 30 * 86_400_000) } } : {}),
    ...(q
      ? {
          OR: [
            { firstName: { contains: q, mode: 'insensitive' } },
            { lastName: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
            ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : []),
          ],
        }
      : {}),
  }
  const conversations = await prisma.hlContact.findMany({
    where,
    orderBy: { lastMessageAt: 'desc' },
    take: 100,
    select: { id: true, firstName: true, lastName: true, phone: true, email: true, lastMessage: true, lastMessageAt: true, unread: true, dnd: true, starred: true, source: true },
  })
  return NextResponse.json({ conversations })
}
