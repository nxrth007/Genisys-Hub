import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/emails/[id]
 * Full email detail including HTML body.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { id } = await ctx.params
  const email = await prisma.email.findUnique({
    where: { id },
    include: {
      account: { select: { email: true } },
    },
  })
  if (!email) return NextResponse.json({ error: 'not found' }, { status: 404 })

  // Mark as read on view if it's still unread
  if (!email.isRead) {
    await prisma.email.update({ where: { id }, data: { isRead: true } })
  }

  return NextResponse.json({ email })
}

/**
 * PATCH /api/emails/[id]
 * Update an email's read status.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { id } = await ctx.params
  const body = await req.json().catch(() => ({}))
  const data: Record<string, unknown> = {}
  if (typeof body.isRead === 'boolean') data.isRead = body.isRead

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'no updatable fields' }, { status: 400 })
  }

  const email = await prisma.email.update({ where: { id }, data })
  return NextResponse.json({ email })
}
