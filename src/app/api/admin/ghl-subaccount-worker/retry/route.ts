import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-helpers'
import { enqueueClient } from '@/lib/ghl-subaccount-worker/queue'
import { prisma } from '@/lib/prisma'

/**
 * POST /api/admin/ghl-subaccount-worker/retry
 * { clientId, action?: 'queue' | 'cancel' }
 *
 * Queue (the default) asks the browser worker to try this client,
 * including one it already dry-ran or gave up on. Cancel parks the
 * job so a later flip to create-mode does not pick a dry run back up.
 */
export async function POST(req: Request) {
  const denial = await requireAdmin()
  if (denial) return denial
  let body: { clientId?: unknown; action?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (typeof body.clientId !== 'string' || !body.clientId.trim()) {
    return NextResponse.json({ error: 'clientId is required' }, { status: 400 })
  }
  const clientId = body.clientId.trim()
  if (body.action === 'cancel') {
    const res = await prisma.ghlSubaccountJob.updateMany({
      where: { clientId, status: { in: ['queued', 'dry_run', 'needs_human', 'failed'] } },
      data: { status: 'canceled', leaseUntil: null, finishedAt: new Date(), detail: 'Canceled from the Hub.' },
    })
    return NextResponse.json({ ok: true, status: res.count ? 'canceled' : 'unchanged' })
  }
  const result = await enqueueClient(clientId, { trigger: 'manual', force: true })
  return NextResponse.json(result, { status: result.ok || result.status === 'skipped' ? 200 : 502 })
}
