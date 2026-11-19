import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { canAccessPayments } from '@/lib/payments-access'
import { saveDisputeConfig, saveTemplate } from '@/lib/disputes/config'
import { summarizeOutcomes } from '@/lib/disputes/plan'
import { listDisputeRows, reconcileDisputes, runProbe } from '@/lib/disputes/run'

async function guard() {
  const session = await auth()
  if (!canAccessPayments(session?.user?.email)) return null
  return session
}

export async function GET() {
  if (!(await guard())) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { rows, config, templates } = await listDisputeRows()
  return NextResponse.json({
    config,
    templates,
    outcomes: summarizeOutcomes(rows.map((r) => ({ reason: r.reason, status: r.status, amountCents: r.amountCents }))),
    disputes: rows.map((r) => ({
      ...r,
      dueBy: r.dueBy?.toISOString() ?? null,
      packetBuiltAt: r.packetBuiltAt?.toISOString() ?? null,
      submittedAt: r.submittedAt?.toISOString() ?? null,
    })),
  })
}

export async function POST(req: Request) {
  const session = await guard()
  if (!session) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const body = (await req.json().catch(() => null)) as { action?: string; reason?: string; body?: string; config?: Record<string, unknown> } | null
  const action = body?.action
  if (action === 'probe') return NextResponse.json(await runProbe())
  if (action === 'reconcile') return NextResponse.json(await reconcileDisputes())
  if (action === 'template') {
    const reason = (body?.reason ?? '').trim()
    if (!reason) return NextResponse.json({ error: 'reason required' }, { status: 400 })
    await saveTemplate(reason, body?.body ?? '')
    return NextResponse.json({ ok: true })
  }
  if (action === 'settings') {
    const patch = body?.config ?? {}
    const mode = patch.mode === 'stage' || patch.mode === 'live' || patch.mode === 'dry_run' ? patch.mode : undefined
    const saved = await saveDisputeConfig({
      ...(mode ? { mode } : {}),
      ...(typeof patch.submitLeadHours === 'number' ? { submitLeadHours: patch.submitLeadHours } : {}),
      ...(typeof patch.efwRefund === 'boolean' ? { efwRefund: patch.efwRefund } : {}),
      ...(typeof patch.alertSms === 'boolean' ? { alertSms: patch.alertSms } : {}),
      ...(typeof patch.clientNotices === 'boolean' ? { clientNotices: patch.clientNotices } : {}),
      ...(typeof patch.openTracking === 'boolean' ? { openTracking: patch.openTracking } : {}),
      ...(typeof patch.milestoneAck === 'boolean' ? { milestoneAck: patch.milestoneAck } : {}),
      ...(typeof patch.stampMetadata === 'boolean' ? { stampMetadata: patch.stampMetadata } : {}),
      ...(patch.inquiryPolicy === 'fight' || patch.inquiryPolicy === 'flag' ? { inquiryPolicy: patch.inquiryPolicy } : {}),
    })
    return NextResponse.json({ ok: true, config: saved })
  }
  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}
