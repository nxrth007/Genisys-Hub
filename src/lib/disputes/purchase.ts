/**
 * Stores a checkout IP, user agent, and device id. Database only.
 * This file does not call Stripe.
 */
import { prisma } from '@/lib/prisma'
import type { PurchaseSignals } from './plan'

export async function rememberPurchase(o: {
  clientId: string | null
  intakeId: string | null
  source: 'intake' | 'stripe_charge'
  sourceId: string
  signals: PurchaseSignals
  occurredAt: Date
}): Promise<void> {
  if (!o.sourceId || (!o.signals.ip && !o.signals.userAgent && !o.signals.deviceId)) return
  const data = {
    clientId: o.clientId,
    intakeId: o.intakeId,
    ip: o.signals.ip,
    userAgent: o.signals.userAgent,
    deviceId: o.signals.deviceId,
    occurredAt: o.occurredAt,
  }
  await prisma.checkoutContext.upsert({
    where: { source_sourceId: { source: o.source, sourceId: o.sourceId } },
    create: { source: o.source, sourceId: o.sourceId, ...data },
    update: data,
  })
}
