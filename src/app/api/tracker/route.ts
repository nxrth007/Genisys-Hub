import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { requireStaff } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'
import { isTrackerStatus, isTrackerStep } from '@/lib/tracker/columns'
import { listTracker, setTrackerStep } from '@/lib/tracker/store'
import { lastSheetSync, sheetSyncEnabled } from '@/lib/tracker/sheet-sync'

/**
 * DB client tracker (src/lib/tracker). Staff only.
 *   GET  ?q=&step=&status=&archived=1      → rows
 *   POST { clientId, step, status, note? } → set one step (audited)
 */
export async function GET(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied
  const p = new URL(req.url).searchParams
  const step = p.get('step')
  const status = p.get('status')
  const rows = await listTracker({
    q: p.get('q') ?? undefined,
    step: isTrackerStep(step) ? step : undefined,
    status: isTrackerStatus(status) ? status : undefined,
    includeArchived: p.get('archived') === '1',
  })
  return NextResponse.json({ rows, sheetSync: { enabled: sheetSyncEnabled(), last: await lastSheetSync() } })
}

export async function POST(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied
  const body = (await req.json().catch(() => null)) as { clientId?: unknown; step?: unknown; status?: unknown; note?: unknown } | null
  if (!body || typeof body.clientId !== 'string' || !body.clientId) return NextResponse.json({ error: 'clientId is required' }, { status: 400 })
  if (!isTrackerStep(body.step)) return NextResponse.json({ error: 'invalid step' }, { status: 400 })
  if (!isTrackerStatus(body.status)) return NextResponse.json({ error: 'invalid status' }, { status: 400 })
  const exists = await prisma.client.findUnique({ where: { id: body.clientId }, select: { id: true } })
  if (!exists) return NextResponse.json({ error: 'client not found' }, { status: 404 })
  const session = await auth()
  const result = await setTrackerStep(body.clientId, body.step, body.status, {
    actor: session?.user?.id ?? null,
    note: typeof body.note === 'string' ? body.note : null,
  })
  return NextResponse.json(result)
}
