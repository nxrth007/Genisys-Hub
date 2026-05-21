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

  // Collect every clientId referenced anywhere in the response — the
  // per-row clientId snapshot AND any `clientId` field change (the
  // common case is Mary moving an appointment between clients, which
  // generates a from/to pair of cuids that mean nothing to a human
  // reader). Resolve them in one batch + include a clientId → client
  // map so the frontend can render names + colors without a second
  // round-trip. Past clients that have since been deleted just won't
  // be in the map — the UI falls back to "Unknown client" + the cuid.
  const clientIdSet = new Set<string>()
  for (const e of edits) {
    if (e.clientId) clientIdSet.add(e.clientId)
    const changes = (e.changes ?? {}) as Record<
      string,
      { from?: unknown; to?: unknown }
    >
    const clientChange = changes.clientId
    if (clientChange) {
      if (typeof clientChange.from === 'string') clientIdSet.add(clientChange.from)
      if (typeof clientChange.to === 'string') clientIdSet.add(clientChange.to)
    }
  }
  const clientRows =
    clientIdSet.size > 0
      ? await prisma.client.findMany({
          where: { id: { in: Array.from(clientIdSet) } },
          select: { id: true, name: true, color: true, state: true },
        })
      : []
  const clients: Record<
    string,
    { id: string; name: string; color: string; state: string | null }
  > = {}
  for (const c of clientRows) clients[c.id] = c

  return NextResponse.json({ edits, clients })
}
