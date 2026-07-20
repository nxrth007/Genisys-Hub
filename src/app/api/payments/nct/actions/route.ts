import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { canAccessPayments } from '@/lib/payments-access'
import {
  getNctSettings,
  rotateNctWebhookToken,
  retryLeadCharge,
  runSweep,
} from '@/lib/nct-billing'

/**
 * POST /api/payments/nct/actions
 *
 * Write actions for the NCT Leads tab. Allowlist-gated like the rest of
 * Payments. Actions:
 *   saveSettings  — charging switch, sweep policy, alert channel
 *   rotateToken   — new webhook secret (breaks NCT's sender until updated)
 *   saveConfig    — create/update a client billing config
 *   deleteConfig  — remove one (leads keep their denormalized client name)
 *   retryCharge   — re-attempt a failed / capped lead
 *   sweepNow      — force a Stripe -> Mercury payout
 */
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!canAccessPayments(session?.user?.email)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const action = String(body.action ?? '')

  try {
    if (action === 'saveSettings') {
      await getNctSettings()
      await prisma.nctBillingSettings.update({
        where: { id: 'singleton' },
        data: {
          chargingEnabled: body.chargingEnabled === true,
          sweepEnabled: body.sweepEnabled === true,
          sweepMethod: body.sweepMethod === 'instant' ? 'instant' : 'standard',
          sweepDestinationId:
            String(body.sweepDestinationId ?? '').trim() || null,
          sweepFloorCents: Math.max(0, Math.round(Number(body.sweepFloorCents ?? 0))),
          sweepMinCents: Math.max(0, Math.round(Number(body.sweepMinCents ?? 0))),
          alertChannel: String(body.alertChannel ?? '').trim() || null,
        },
      })
      return NextResponse.json({ ok: true, message: 'Settings saved.' })
    }

    if (action === 'rotateToken') {
      const updated = await rotateNctWebhookToken()
      return NextResponse.json({
        ok: true,
        message: 'New token generated — send it to NCT before the next lead.',
        webhookToken: updated.webhookToken,
      })
    }

    if (action === 'saveConfig') {
      const clientName = String(body.clientName ?? '').trim()
      const stripeCustomerId = String(body.stripeCustomerId ?? '').trim()
      const sourceKey = String(body.sourceKey ?? '')
        .trim()
        .toLowerCase()
      if (!clientName || !stripeCustomerId || !sourceKey) {
        return NextResponse.json(
          { error: 'Client name, Stripe customer ID and source key are required.' },
          { status: 400 },
        )
      }
      if (!stripeCustomerId.startsWith('cus_')) {
        return NextResponse.json(
          { error: 'Stripe customer ID should look like cus_XXXXXXXX.' },
          { status: 400 },
        )
      }

      const data = {
        clientName,
        stripeCustomerId,
        sourceKey,
        pricePerLeadCents: Math.round(Number(body.pricePerLeadCents ?? 15000)),
        costPerLeadCents: Math.round(Number(body.costPerLeadCents ?? 11000)),
        weeklyCapCents: Math.max(0, Math.round(Number(body.weeklyCapCents ?? 0))),
        active: body.active !== false,
        contactName: String(body.contactName ?? '').trim() || null,
        contactEmail: String(body.contactEmail ?? '').trim() || null,
        contactPhone: String(body.contactPhone ?? '').trim() || null,
        notes: String(body.notes ?? '').trim() || null,
      }

      const id = String(body.id ?? '')
      if (id) {
        await prisma.nctBillingConfig.update({ where: { id }, data })
        return NextResponse.json({ ok: true, message: `${clientName} updated.` })
      }
      const existing = await prisma.nctBillingConfig.findUnique({
        where: { sourceKey },
      })
      if (existing) {
        return NextResponse.json(
          { error: `Source key "${sourceKey}" is already in use.` },
          { status: 400 },
        )
      }
      await prisma.nctBillingConfig.create({ data })
      return NextResponse.json({ ok: true, message: `${clientName} added.` })
    }

    if (action === 'deleteConfig') {
      const id = String(body.id ?? '')
      if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
      await prisma.nctBillingConfig.delete({ where: { id } })
      return NextResponse.json({ ok: true, message: 'Client removed.' })
    }

    if (action === 'retryCharge') {
      const id = String(body.id ?? '')
      if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
      const result = await retryLeadCharge(id)
      return NextResponse.json({
        ok: result.ok,
        message: result.ok
          ? `Lead ${result.leadId} charged.`
          : `Still failing: ${result.reason ?? 'unknown error'}`,
      })
    }

    if (action === 'sweepNow') {
      const result = await runSweep(true)
      const dollars = `$${(result.amountCents / 100).toFixed(2)}`
      return NextResponse.json({
        ok: result.status !== 'failed',
        message:
          result.status === 'ok'
            ? `Payout of ${dollars} sent to Mercury.`
            : result.status === 'skipped'
              ? `Nothing swept — ${result.detail}`
              : `Sweep failed — ${result.detail}`,
      })
    }

    return NextResponse.json({ error: `Unknown action "${action}"` }, { status: 400 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Action failed.'
    console.error('[nct-actions]', action, err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
