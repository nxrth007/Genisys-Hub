/**
 * Loads the Hub's proof for one dispute and shapes it for buildEvidence.
 * Stripe charges are passed in by the caller so this file does not talk
 * to Stripe itself.
 */
import { prisma } from '@/lib/prisma'
import { syncServiceLedger } from './ledger'
import { syncSetupMilestones } from './setup'
import { readCharge, type EvidenceFacts, type PriorCharge } from './plan'

export async function gatherFacts(o: {
  disputeId: string
  clientId: string | null
  intakeId: string | null
  reason: string
  status: string
  amountCents: number
  currency: string
  dueBy: Date | null
  chargedAt: Date | null
  cardBrand: string | null
  email: string | null
  name: string | null
  phone: string | null
  billingAddress: string | null
  chargeRefunded: boolean
  narrative: string | null
  template: string | null
  priorCharges: unknown[]
}): Promise<EvidenceFacts> {
  if (o.clientId) {
    await syncServiceLedger(o.clientId).catch((err) => console.error('[disputes] ledger sync:', err instanceof Error ? err.message : 'failed'))
    await syncSetupMilestones(o.clientId).catch((err) => console.error('[disputes] setup milestones:', err instanceof Error ? err.message : 'failed'))
  }

  const client = o.clientId
    ? await prisma.client.findUnique({
        where: { id: o.clientId },
        select: { id: true, name: true, contactEmail: true, contactPhone: true, address: true, package: true, serviceStartDate: true, website: true, siteUrl: true, disputeCount: true },
      })
    : null
  const intake = o.intakeId
    ? await prisma.clientIntake.findUnique({
        where: { id: o.intakeId },
        select: { id: true, receivedAt: true, businessName: true, fullName: true, leadEmail: true, customerPhone: true, businessAddress: true, mainServices: true },
      })
    : o.clientId
      ? await prisma.clientIntake.findFirst({
          where: { clientId: o.clientId },
          orderBy: { receivedAt: 'desc' },
          select: { id: true, receivedAt: true, businessName: true, fullName: true, leadEmail: true, customerPhone: true, businessAddress: true, mainServices: true },
        })
      : null

  const [acks, ledger, receipts, invoices, logins] = await Promise.all([
    prisma.serviceAcknowledgement.findMany({
      where: o.clientId ? { clientId: o.clientId } : intake ? { intakeId: intake.id } : { id: 'none' },
      orderBy: { acceptedAt: 'asc' },
      take: 30,
    }),
    o.clientId
      ? prisma.serviceLedgerEntry.findMany({ where: { clientId: o.clientId }, orderBy: { occurredAt: 'asc' }, take: 200 })
      : Promise.resolve([]),
    o.clientId
      ? prisma.deliveryReceipt.findMany({ where: { clientId: o.clientId }, orderBy: { sentAt: 'desc' }, take: 30 })
      : Promise.resolve([]),
    o.clientId
      ? prisma.invoice.findMany({ where: { clientId: o.clientId }, orderBy: { createdAt: 'desc' }, take: 24 })
      : Promise.resolve([]),
    o.clientId
      ? prisma.portalActivity.findMany({ where: { clientId: o.clientId }, orderBy: { createdAt: 'desc' }, take: 30 })
      : Promise.resolve([]),
  ])

  const emails = o.clientId ? await clientEmails(o.clientId, client?.contactEmail ?? intake?.leadEmail ?? o.email) : []
  const priors: PriorCharge[] = []
  for (const ch of o.priorCharges) {
    const parsed = readCharge(ch, client?.id ?? null)
    if (parsed) priors.push(parsed)
  }

  return {
    dispute: {
      id: o.disputeId,
      reason: o.reason,
      status: o.status,
      amountCents: o.amountCents,
      currency: o.currency,
      dueBy: o.dueBy?.toISOString() ?? null,
      chargedAt: o.chargedAt?.toISOString() ?? null,
      cardBrand: o.cardBrand,
      email: o.email,
      name: o.name,
      phone: o.phone,
      billingAddress: o.billingAddress,
      purchaseIp: null,
      chargeRefunded: o.chargeRefunded,
    },
    client: client
      ? {
          id: client.id,
          name: client.name,
          email: client.contactEmail,
          phone: client.contactPhone,
          address: client.address,
          packageName: client.package,
          serviceStart: client.serviceStartDate?.toISOString() ?? null,
          website: client.siteUrl ?? client.website,
          disputeCount: client.disputeCount,
        }
      : null,
    intake: intake
      ? {
          id: intake.id,
          receivedAt: intake.receivedAt.toISOString(),
          businessName: intake.businessName,
          fullName: intake.fullName,
          email: intake.leadEmail,
          phone: intake.customerPhone,
          address: intake.businessAddress,
          services: intake.mainServices,
        }
      : null,
    acknowledgements: acks.map((a) => ({
      kind: a.kind,
      version: a.version,
      acceptedAt: a.acceptedAt.toISOString(),
      ip: a.ip,
      userAgent: a.userAgent,
      source: a.source,
      contentHash: a.contentHash,
    })),
    ledger: ledger.map((l) => ({
      kind: l.kind,
      title: l.title,
      detail: l.detail,
      occurredAt: l.occurredAt.toISOString(),
      contentHash: l.contentHash,
    })),
    emails,
    receipts: receipts.map((r) => ({
      channel: r.channel,
      kind: r.kind,
      to: r.toAddress,
      sentAt: r.sentAt.toISOString(),
      deliveredAt: r.deliveredAt?.toISOString() ?? null,
      openedAt: r.openedAt?.toISOString() ?? null,
      subject: r.subject,
    })),
    invoices: invoices.map((inv) => ({
      at: inv.createdAt.toISOString(),
      amountCents: inv.amountCents,
      appointments: inv.appointmentCount,
      emailSentAt: inv.emailSentAt?.toISOString() ?? null,
      smsSentAt: inv.smsSentAt?.toISOString() ?? null,
    })),
    logins: logins.map((l) => ({ at: l.createdAt.toISOString(), email: l.email, ip: l.ip, kind: l.kind })),
    priors,
    narrative: o.narrative,
    template: o.template,
  }
}

async function clientEmails(clientId: string, email: string | null): Promise<EvidenceFacts['emails']> {
  const addresses = [...new Set([email].filter((e): e is string => !!e && e.includes('@')).map((e) => e.toLowerCase()))]
  if (!addresses.length) return []
  const rows = await prisma.email.findMany({
    where: { OR: addresses.flatMap((e) => [{ from: { contains: e, mode: 'insensitive' } }, { to: { contains: e, mode: 'insensitive' } }]) },
    orderBy: { date: 'desc' },
    take: 25,
    select: { date: true, from: true, to: true, subject: true, snippet: true, folder: true },
  })
  return rows.map((m) => ({
    direction: addresses.some((e) => m.from.toLowerCase().includes(e)) && m.folder !== 'sent' ? 'in' : 'out',
    at: m.date.toISOString(),
    from: m.from,
    to: m.to,
    subject: m.subject,
    snippet: (m.snippet ?? '').slice(0, 240),
  }))
}

export async function screenshotFor(clientId: string): Promise<{ bytes: Buffer; mime: string } | null> {
  const job = await prisma.ghlSubaccountJob.findUnique({
    where: { clientId },
    select: { status: true, shots: { orderBy: { createdAt: 'desc' }, take: 1, select: { mime: true, data: true } } },
  })
  if (!job || job.status !== 'succeeded') return null
  const shot = job.shots[0]
  if (!shot) return null
  if (shot.mime !== 'image/png' && shot.mime !== 'image/jpeg') return null
  return { bytes: Buffer.from(shot.data), mime: shot.mime }
}
