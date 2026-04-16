import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/emails
 * Lists emails with filters.
 *
 * Query:
 *   ?account=alex@leadgenisys.com  — scope to one account (default: all)
 *   ?folder=inbox | sent           — filter by folder (default: inbox)
 *   ?search=...                    — substring search on subject/from/snippet
 *   ?limit=50                      — page size (max 200)
 *   ?offset=0                      — pagination offset
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const account = req.nextUrl.searchParams.get('account')
  const folder = req.nextUrl.searchParams.get('folder') || 'inbox'
  const search = req.nextUrl.searchParams.get('search')?.trim()
  const limit = Math.min(Number(req.nextUrl.searchParams.get('limit')) || 50, 200)
  const offset = Number(req.nextUrl.searchParams.get('offset')) || 0

  const where: Record<string, unknown> = { folder }
  if (account) {
    const acc = await prisma.gmailAccount.findUnique({ where: { email: account } })
    if (!acc) return NextResponse.json({ emails: [], total: 0 })
    where.accountId = acc.id
  }
  if (search) {
    where.OR = [
      { subject: { contains: search, mode: 'insensitive' } },
      { from: { contains: search, mode: 'insensitive' } },
      { fromName: { contains: search, mode: 'insensitive' } },
      { snippet: { contains: search, mode: 'insensitive' } },
    ]
  }

  const [emails, total] = await Promise.all([
    prisma.email.findMany({
      where,
      orderBy: { date: 'desc' },
      take: limit,
      skip: offset,
      select: {
        id: true,
        gmailMessageId: true,
        threadId: true,
        from: true,
        fromName: true,
        to: true,
        subject: true,
        snippet: true,
        date: true,
        isRead: true,
        folder: true,
        account: { select: { email: true } },
      },
    }),
    prisma.email.count({ where }),
  ])

  return NextResponse.json({ emails, total })
}
