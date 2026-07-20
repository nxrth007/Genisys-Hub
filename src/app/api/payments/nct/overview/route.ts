import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { canAccessPayments } from '@/lib/payments-access'
import {
  getNctSettings,
  currentWeekStart,
  listPayoutDestinations,
} from '@/lib/nct-billing'

/**
 * GET /api/payments/nct/overview
 *
 * Everything the NCT Leads tab renders: webhook credential, client
 * configs with live weekly spend, the lead ledger, sweep history, and
 * this week's margin. Gated to the Payments email allowlist.
 */
export async function GET() {
  const session = await auth()
  if (!canAccessPayments(session?.user?.email)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const weekStart = currentWeekStart()

  const [settings, configs, leads, sweeps, weekAgg, lifeAgg, lastLeads, destinations] =
    await Promise.all([
      getNctSettings(),
      prisma.nctBillingConfig.findMany({ orderBy: { createdAt: 'asc' } }),
      prisma.nctLead.findMany({
        orderBy: { receivedAt: 'desc' },
        take: 100,
      }),
      prisma.nctSweep.findMany({ orderBy: { createdAt: 'desc' }, take: 15 }),
      prisma.nctLead.groupBy({
        by: ['configId'],
        where: { chargeStatus: 'charged', chargedAt: { gte: weekStart } },
        _sum: { amountCents: true },
        _count: { _all: true },
      }),
      // Lifetime billed totals, for the Roofing Clients tab.
      prisma.nctLead.groupBy({
        by: ['configId'],
        where: { chargeStatus: 'charged' },
        _sum: { amountCents: true },
        _count: { _all: true },
      }),
      // Most recent lead per client (charged or not) — "are they still live?"
      prisma.nctLead.groupBy({
        by: ['configId'],
        _max: { receivedAt: true },
      }),
      listPayoutDestinations(),
    ])

  const spentByConfig = new Map(
    weekAgg.map((r) => [
      r.configId ?? '',
      { cents: r._sum.amountCents ?? 0, count: r._count._all },
    ]),
  )
  const lifetimeByConfig = new Map(
    lifeAgg.map((r) => [
      r.configId ?? '',
      { cents: r._sum.amountCents ?? 0, count: r._count._all },
    ]),
  )
  const lastLeadByConfig = new Map(
    lastLeads.map((r) => [r.configId ?? '', r._max.receivedAt]),
  )

  const weekCharged = weekAgg.reduce((s, r) => s + (r._sum.amountCents ?? 0), 0)
  const weekCount = weekAgg.reduce((s, r) => s + r._count._all, 0)
  // What NCT will bill us for those same leads — margin, not a real charge.
  const weekCost = configs.reduce((s, c) => {
    const n = spentByConfig.get(c.id)?.count ?? 0
    return s + n * c.costPerLeadCents
  }, 0)

  const failedCount = leads.filter((l) => l.chargeStatus === 'failed').length
  const cappedCount = leads.filter((l) => l.chargeStatus === 'capped').length

  return NextResponse.json({
    ok: true,
    settings: {
      webhookToken: settings.webhookToken,
      chargingEnabled: settings.chargingEnabled,
      sweepEnabled: settings.sweepEnabled,
      sweepMethod: settings.sweepMethod,
      sweepDestinationId: settings.sweepDestinationId,
      sweepFloorCents: settings.sweepFloorCents,
      sweepMinCents: settings.sweepMinCents,
      alertChannel: settings.alertChannel,
      notifyEveryLead: settings.notifyEveryLead,
      lastSweepAt: settings.lastSweepAt,
    },
    destinations,
    configs: configs.map((c) => ({
      id: c.id,
      clientName: c.clientName,
      stripeCustomerId: c.stripeCustomerId,
      pricePerLeadCents: c.pricePerLeadCents,
      costPerLeadCents: c.costPerLeadCents,
      weeklyCapCents: c.weeklyCapCents,
      sourceKey: c.sourceKey,
      active: c.active,
      contactName: c.contactName,
      contactEmail: c.contactEmail,
      contactPhone: c.contactPhone,
      notes: c.notes,
      createdAt: c.createdAt,
      weekSpentCents: spentByConfig.get(c.id)?.cents ?? 0,
      weekLeadCount: spentByConfig.get(c.id)?.count ?? 0,
      lifetimeRevenueCents: lifetimeByConfig.get(c.id)?.cents ?? 0,
      lifetimeLeadCount: lifetimeByConfig.get(c.id)?.count ?? 0,
      lifetimeCostCents:
        (lifetimeByConfig.get(c.id)?.count ?? 0) * c.costPerLeadCents,
      lastLeadAt: lastLeadByConfig.get(c.id) ?? null,
    })),
    week: {
      startsAt: weekStart,
      chargedCents: weekCharged,
      leadCount: weekCount,
      costCents: weekCost,
      marginCents: weekCharged - weekCost,
    },
    alerts: { failedCount, cappedCount },
    leads: leads.map((l) => ({
      id: l.id,
      leadId: l.leadId,
      name: l.name,
      phone: l.phone,
      email: l.email,
      address: l.address,
      service: l.service,
      clientName: l.clientName,
      amountCents: l.amountCents,
      chargeStatus: l.chargeStatus,
      failureReason: l.failureReason,
      receivedAt: l.receivedAt,
      chargedAt: l.chargedAt,
    })),
    sweeps: sweeps.map((s) => ({
      id: s.id,
      amountCents: s.amountCents,
      method: s.method,
      status: s.status,
      detail: s.detail,
      manual: s.manual,
      stripePayoutId: s.stripePayoutId,
      createdAt: s.createdAt,
    })),
  })
}
