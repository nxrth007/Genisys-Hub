import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-helpers'
import { recentWorkerJobs, submitWorkerOtp, workerCutoff, workerPublicStatus } from '@/lib/ghl-subaccount-worker/queue'

/**
 * GET /api/admin/ghl-subaccount-worker
 * Whether the browser worker is switched on, and the latest jobs.
 *
 * POST { code, clientId? } — a GHL verification code. The running job
 * picks it up, or the waiting job is queued again.
 */
export async function GET() {
  const denial = await requireAdmin()
  if (denial) return denial
  const [jobs, since] = await Promise.all([
    recentWorkerJobs(),
    workerPublicStatus().enabled ? workerCutoff().catch(() => null) : Promise.resolve(null),
  ])
  return NextResponse.json({
    worker: workerPublicStatus(),
    since: since?.toISOString() ?? null,
    jobs,
  })
}

export async function POST(req: Request) {
  const denial = await requireAdmin()
  if (denial) return denial
  let body: { code?: unknown; clientId?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (typeof body.code !== 'string') {
    return NextResponse.json({ error: 'code is required' }, { status: 400 })
  }
  const clientId = typeof body.clientId === 'string' && body.clientId.trim() ? body.clientId.trim() : null
  const result = await submitWorkerOtp(body.code, clientId)
  return NextResponse.json(result, { status: result.ok ? 200 : 400 })
}
