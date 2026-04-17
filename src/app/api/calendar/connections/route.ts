import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/calendar/connections
 * List all calendar connections (iCal URLs, future OAuth connections)
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const connections = await prisma.calendarConnection.findMany({
    orderBy: { label: 'asc' },
    select: {
      id: true,
      label: true,
      provider: true,
      email: true,
      icalUrl: true,
      createdAt: true,
    },
  })
  return NextResponse.json({ connections })
}

const CreateSchema = z.object({
  label: z.string().min(1).max(100),
  icalUrl: z.string().url().startsWith('https://'),
})

/**
 * POST /api/calendar/connections
 * Add a new iCal calendar connection
 */
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => null)
  const parsed = CreateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 })
  }

  const conn = await prisma.calendarConnection.create({
    data: {
      userId: session.user.id,
      provider: 'ical',
      label: parsed.data.label,
      icalUrl: parsed.data.icalUrl,
    },
  })

  return NextResponse.json({ id: conn.id }, { status: 201 })
}

/**
 * DELETE /api/calendar/connections?id=...
 */
export async function DELETE(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  try {
    await prisma.calendarConnection.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
}
