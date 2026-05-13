import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/admin/appointment-edits
 *
 * Returns recent AppointmentEditLog rows for the "Appointment edits"
 * tab on /agents. Most-recent first.
 *
 * Query params:
 *   limit=N  — return up to N rows (default 200, max 500)
 *   userId=  — filter to edits by a specific editor (e.g. Mary's id)
 *
 * Admin/member only — this is internal triage data.
 */
const DEFAULT_LIMIT = 200
const MAX_LIMIT = 500

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string }).role
  if (role !== 'admin' && role !== 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const limitRaw = parseInt(req.nextUrl.searchParams.get('limit') ?? '', 10)
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(limitRaw, MAX_LIMIT)
    : DEFAULT_LIMIT
  const userId = req.nextUrl.searchParams.get('userId') ?? null

  const edits = await prisma.appointmentEditLog.findMany({
    where: userId ? { editorUserId: userId } : undefined,
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      appointmentId: true,
      sheetTabTitle: true,
      sheetRowNumber: true,
      clientId: true,
      clientName: true,
      editorUserId: true,
      editorEmail: true,
      editorName: true,
      customerName: true,
      customerPhone: true,
      apptDateTime: true,
      source: true,
      changes: true,
      createdAt: true,
    },
  })

  return NextResponse.json({ edits })
}
