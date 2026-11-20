import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { requireStaff } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'
import { MANUAL_STEPS, STEP_TITLE, isStepState, readStep } from '@/lib/tracker/derive'
import { listTracker, manualStepFor, setTrackerStep } from '@/lib/tracker/store'
import { lastSheetSync, sheetSyncEnabled } from '@/lib/tracker/sheet-sync'

/**
 * The derived client tracker (src/lib/tracker). Staff only.
 *   GET  ?q=&show=&stage=&step=&state=&stripe=1&archived=1&refresh=1
 *                                  → rows, summary, billing read, sheet sync (stripe=1: only clients Stripe knows)
 *   POST { clientId, step, status, note? }                    → a hand mark on one of the five
 *                                                               hand-markable steps (audited)
 */
export async function GET(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied
  const p = new URL(req.url).searchParams
  const show = p.get('show')
  const state = p.get('state')
  const list = await listTracker({
    q: p.get('q') ?? undefined,
    step: readStep(p.get('step')) ?? undefined,
    state: isStepState(state) ? state : undefined,
    stage: readStep(p.get('stage')) ?? undefined,
    show: show === 'stuck' || show === 'blocked' || show === 'complete' || show === 'working' ? show : 'all',
    stripe: p.get('stripe') === '1',
    includeArchived: p.get('archived') === '1',
    refresh: p.get('refresh') === '1',
  })
  return NextResponse.json({ ...list, sheetSync: { enabled: sheetSyncEnabled(), last: await lastSheetSync() } })
}

export async function POST(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied
  const body = (await req.json().catch(() => null)) as { clientId?: unknown; step?: unknown; status?: unknown; note?: unknown } | null
  if (!body || typeof body.clientId !== 'string' || !body.clientId) return NextResponse.json({ error: 'clientId is required' }, { status: 400 })
  const step = manualStepFor(body.step)
  if (!step) {
    const known = readStep(body.step)
    return NextResponse.json(
      { error: known ? `${STEP_TITLE[known]} is read from the Hub and can’t be set by hand.` : `step must be one of: ${MANUAL_STEPS.join(', ')}` },
      { status: 400 },
    )
  }
  if (body.status !== 'done' && body.status !== 'pending') return NextResponse.json({ error: 'status must be done or pending' }, { status: 400 })
  const exists = await prisma.client.findUnique({ where: { id: body.clientId }, select: { id: true } })
  if (!exists) return NextResponse.json({ error: 'client not found' }, { status: 404 })
  const session = await auth()
  const result = await setTrackerStep(body.clientId, step, body.status, {
    actor: session?.user?.id ?? null,
    note: typeof body.note === 'string' ? body.note : null,
  })
  return NextResponse.json({ step, ...result })
}
