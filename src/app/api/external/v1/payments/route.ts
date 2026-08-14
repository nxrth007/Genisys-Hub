import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { withExternalApi, externalOptions } from '@/lib/external-api'
import { currentWeekStart } from '@/lib/nct-billing'
import { maskPhone } from '../_mask'

/**
 * GET /api/external/v1/payments — NCT roofing-lead billing.
 *
 * Reads our own ledger only. Deliberately does NOT proxy Stripe or
 * Mercury: those sit behind Vault keys and the Payments email
 * allowlist, and a browser app has no business reaching them.
 */
export const GET = withExternalApi(async () => {
  const weekStart = currentWeekStart()

  const [configs, leads, sweeps, weekAgg] = await Promise.all([
    prisma.nctBillingConfig.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.nctLead.findMany({ orderBy: { receivedAt: 'desc' }, take: 40 }),
    prisma.nctSweep.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
    prisma.nctLead.groupBy({
      by: ['configId'],
      where: { chargeStatus: 'charged', chargedAt: { gte: weekStart } },
      _sum: { amountCents: true },
      _count: { _all: true },
    }),
  ])

  const spent = new Map(
    weekAgg.map((r) => [
      r.configId ?? '',
      { cents: r._sum.amountCents ?? 0, count: r._count._all },
    ]),
  )
  const weekCharged = weekAgg.reduce((s, r) => s + (r._sum.amountCents ?? 0), 0)
  const weekCost = configs.reduce(
    (s, c) => s + (spent.get(c.id)?.count ?? 0) * c.costPerLeadCents,
    0,
  )

  return {
    week: {
      chargedCents: weekCharged,
      costCents: weekCost,
      marginCents: weekCharged - weekCost,
      leadCount: weekAgg.reduce((s, r) => s + r._count._all, 0),
    },
    clients: configs.map((c) => ({
      id: c.id,
      clientName: c.clientName,
      contactName: c.contactName,
      pricePerLeadCents: c.pricePerLeadCents,
      costPerLeadCents: c.costPerLeadCents,
      weeklyCapCents: c.weeklyCapCents,
      active: c.active,
      hasStripeId: !!c.stripeCustomerId,
      weekSpentCents: spent.get(c.id)?.cents ?? 0,
    })),
    leads: leads.map((l) => ({
      id: l.id,
      leadId: l.leadId,
      name: l.name,
      phone: maskPhone(l.phone),
      address: l.address,
      clientName: l.clientName,
      amountCents: l.amountCents,
      chargeStatus: l.chargeStatus,
      failureReason: l.failureReason,
      receivedAt: l.receivedAt,
    })),
    sweeps: sweeps.map((s) => ({
      id: s.id,
      amountCents: s.amountCents,
      method: s.method,
      status: s.status,
      createdAt: s.createdAt,
    })),
  }
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
