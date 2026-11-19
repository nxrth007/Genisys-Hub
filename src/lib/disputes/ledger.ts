/**
 * The per-client service ledger. A scanner copies proof the Hub already
 * stored (onboarding, sub-account, leads, appointments, invoices, mail,
 * logins) into append-only hashed rows. It does not touch the GHL
 * sub-account worker; it only reads the job row the worker already wrote.
 */
import { prisma } from '@/lib/prisma'
import { acknowledgementHash, emailHeaderHas, ledgerHash, parseAcceptance, sha256 } from './plan'

export type NewRow = {
  clientId: string
  kind: string
  title: string
  detail: string | null
  occurredAt: Date
  source: string
  sourceId: string
}

function row(r: NewRow): NewRow & { contentHash: string } {
  return {
    ...r,
    contentHash: ledgerHash({
      clientId: r.clientId,
      kind: r.kind,
      title: r.title,
      detail: r.detail,
      occurredAt: r.occurredAt.toISOString(),
      source: r.source,
      sourceId: r.sourceId,
    }),
  }
}

export async function writeLedger(rows: NewRow[]): Promise<number> {
  if (!rows.length) return 0
  const data = rows.map(row)
  const res = await prisma.serviceLedgerEntry.createMany({ data, skipDuplicates: true })
  return res.count
}

const clip = (s: string | null | undefined, n = 240) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n) || null

/** Copy this client's existing records into the ledger. Safe to run often. */
export async function syncServiceLedger(clientId: string): Promise<number> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      name: true,
      contactEmail: true,
      ghlLocationId: true,
      ghlProvisionStatus: true,
      ghlProvisionedAt: true,
      leadAlertInstallStatus: true,
      leadAlertInstallAt: true,
      siteLiveAt: true,
      siteUrl: true,
      serviceStartDate: true,
      intakes: { select: { id: true, receivedAt: true, businessName: true, leadEmail: true, raw: true } },
      users: { select: { email: true } },
    },
  })
  if (!client) return 0
  const rows: NewRow[] = []
  const add = (r: NewRow) => rows.push(r)

  for (const intake of client.intakes) {
    add({
      clientId,
      kind: 'onboarding',
      title: `Onboarding submitted${intake.businessName ? ` for ${intake.businessName}` : ''}`,
      detail: intake.leadEmail,
      occurredAt: intake.receivedAt,
      source: 'intake',
      sourceId: intake.id,
    })
    await backfillAcceptance(clientId, intake.id, intake.leadEmail, intake.raw, intake.receivedAt)
  }

  if (client.ghlProvisionedAt && (client.ghlProvisionStatus === 'created' || client.ghlProvisionStatus === 'linked')) {
    add({
      clientId,
      kind: 'ghl_subaccount',
      title: 'GoHighLevel sub-account provisioned',
      detail: client.ghlLocationId ? `location ${client.ghlLocationId}` : null,
      occurredAt: client.ghlProvisionedAt,
      source: 'client_ghl',
      sourceId: clientId,
    })
  }
  if (client.leadAlertInstallStatus === 'installed' && client.leadAlertInstallAt) {
    add({
      clientId,
      kind: 'campaign',
      title: 'Lead-alert campaign installed in the sub-account',
      detail: null,
      occurredAt: client.leadAlertInstallAt,
      source: 'lead_alert_install',
      sourceId: clientId,
    })
  }
  const job = await prisma.ghlSubaccountJob.findUnique({ where: { clientId }, select: { id: true, status: true, finishedAt: true, locationId: true } })
  if (job && job.status === 'succeeded' && job.finishedAt) {
    add({
      clientId,
      kind: 'ghl_subaccount',
      title: 'Sub-account browser job succeeded',
      detail: job.locationId ? `location ${job.locationId}` : null,
      occurredAt: job.finishedAt,
      source: 'ghl_job',
      sourceId: job.id,
    })
  }

  const customize = await prisma.ghlCustomizeJob.findUnique({ where: { clientId }, select: { id: true, status: true, finishedAt: true } })
  if (customize && customize.status === 'succeeded' && customize.finishedAt) {
    add({
      clientId,
      kind: 'campaign',
      title: 'Incoming-lead workflows customized',
      detail: null,
      occurredAt: customize.finishedAt,
      source: 'ghl_customize',
      sourceId: customize.id,
    })
  }

  const leads = await prisma.leadAlert.findMany({
    where: { clientId, status: 'delivered' },
    orderBy: { createdAt: 'desc' },
    take: 40,
    select: { id: true, createdAt: true, leadName: true, source: true, deliveredAt: true },
  })
  for (const lead of leads) {
    add({
      clientId,
      kind: 'lead',
      title: `Lead delivered${lead.leadName ? `: ${lead.leadName}` : ''}`,
      detail: lead.source,
      occurredAt: lead.deliveredAt ?? lead.createdAt,
      source: 'lead_alert',
      sourceId: lead.id,
    })
  }

  const appts = await prisma.appointment.findMany({
    where: { clientId },
    orderBy: { apptDateTime: 'desc' },
    take: 40,
    select: { id: true, apptDateTime: true, status: true, customerName: true, createdAt: true },
  })
  for (const a of appts) {
    add({
      clientId,
      kind: 'appointment',
      title: `Appointment ${a.status}: ${a.customerName}`,
      detail: null,
      occurredAt: a.apptDateTime,
      source: 'appointment',
      sourceId: a.id,
    })
  }

  const invoices = await prisma.invoice.findMany({
    where: { clientId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true, createdAt: true, amountCents: true, appointmentCount: true, emailSentAt: true, smsSentAt: true },
  })
  for (const inv of invoices) {
    add({
      clientId,
      kind: 'invoice',
      title: `Invoice for ${inv.appointmentCount} appointments ($${(inv.amountCents / 100).toFixed(2)})`,
      detail: [inv.emailSentAt ? 'emailed' : null, inv.smsSentAt ? 'texted' : null].filter(Boolean).join(', ') || null,
      occurredAt: inv.createdAt,
      source: 'invoice',
      sourceId: inv.id,
    })
  }

  const emails = [client.contactEmail, ...client.intakes.map((i) => i.leadEmail), ...client.users.map((u) => u.email)]
    .map((e) => e?.trim().toLowerCase())
    .filter((e): e is string => !!e && e.includes('@'))
  const uniqueEmails = [...new Set(emails)]
  if (uniqueEmails.length) {
    const mail = await prisma.email.findMany({
      where: { OR: uniqueEmails.flatMap((e) => [{ from: { contains: e, mode: 'insensitive' } }, { to: { contains: e, mode: 'insensitive' } }]) },
      orderBy: { date: 'desc' },
      take: 40,
      select: { id: true, date: true, from: true, to: true, subject: true, folder: true, snippet: true },
    })
    const matchedMail = mail.filter((m) => uniqueEmails.some((e) => emailHeaderHas(m.from, e) || emailHeaderHas(m.to, e)))
    for (const m of matchedMail) {
      const inbound = uniqueEmails.some((e) => emailHeaderHas(m.from, e)) && m.folder !== 'sent'
      add({
        clientId,
        kind: inbound ? 'reply' : 'email_out',
        title: inbound ? `Client reply: ${m.subject}` : `Email sent: ${m.subject}`,
        detail: clip(m.snippet),
        occurredAt: m.date,
        source: 'email',
        sourceId: m.id,
      })
    }
  }

  const sms = await prisma.clientAlertDelivery.findMany({
    where: { clientId, status: 'delivered' },
    orderBy: { createdAt: 'desc' },
    take: 40,
    select: { id: true, createdAt: true, deliveredAt: true },
  })
  for (const s of sms) {
    add({ clientId, kind: 'sms', title: 'Appointment alert texted to the client', detail: null, occurredAt: s.deliveredAt ?? s.createdAt, source: 'client_alert', sourceId: s.id })
  }

  const reports = await prisma.clientEmailDelivery.findMany({
    where: { clientId, status: 'delivered' },
    orderBy: { createdAt: 'desc' },
    take: 40,
    select: { id: true, createdAt: true, deliveredAt: true, recipientEmail: true },
  })
  for (const r of reports) {
    add({ clientId, kind: 'report', title: `Report emailed to ${r.recipientEmail}`, detail: null, occurredAt: r.deliveredAt ?? r.createdAt, source: 'client_email', sourceId: r.id })
  }

  const logins = await prisma.portalActivity.findMany({
    where: { clientId },
    orderBy: { createdAt: 'desc' },
    take: 40,
    select: { id: true, createdAt: true, kind: true, email: true, ip: true, path: true },
  })
  for (const l of logins) {
    add({
      clientId,
      kind: 'login',
      title: l.kind === 'login' ? `Portal login${l.email ? ` ${l.email}` : ''}` : `Portal visit${l.path ? ` ${l.path}` : ''}`,
      detail: l.ip ? `ip ${l.ip}` : null,
      occurredAt: l.createdAt,
      source: 'portal',
      sourceId: l.id,
    })
  }

  const journey = await prisma.clientJourneyEvent.findMany({
    where: { clientId },
    orderBy: { createdAt: 'desc' },
    take: 30,
    select: { id: true, createdAt: true, stage: true, toStatus: true, note: true },
  })
  for (const j of journey) {
    add({ clientId, kind: 'journey', title: `${j.stage} → ${j.toStatus}`, detail: clip(j.note), occurredAt: j.createdAt, source: 'journey', sourceId: j.id })
  }

  const account = await prisma.hlAccount.findUnique({ where: { clientId }, select: { id: true } })
  if (account) {
    const messages = await prisma.hlMessage.findMany({
      where: { accountId: account.id, channel: { in: ['sms', 'email'] } },
      orderBy: { createdAt: 'desc' },
      take: 40,
      select: { id: true, createdAt: true, direction: true, channel: true, body: true, status: true },
    })
    for (const m of messages) {
      add({
        clientId,
        kind: m.direction === 'inbound' ? 'reply' : m.channel === 'email' ? 'email_out' : 'sms',
        title: `Sub-account ${m.channel} ${m.direction} (${m.status})`,
        detail: clip(m.body, 180),
        occurredAt: m.createdAt,
        source: 'hl_message',
        sourceId: m.id,
      })
    }
  }

  const notices = await prisma.serviceNotice.findMany({ where: { clientId }, orderBy: { sentAt: 'desc' }, take: 30, select: { id: true, sentAt: true, kind: true, channel: true, subject: true } })
  for (const n of notices) {
    add({ clientId, kind: 'notice', title: `${n.kind} via ${n.channel}${n.subject ? `: ${n.subject}` : ''}`, detail: null, occurredAt: n.sentAt, source: 'notice', sourceId: n.id })
  }

  return writeLedger(rows)
}

export async function captureIntakeAcceptance(clientId: string | null, intakeId: string, email: string | null, raw: unknown, receivedAt: Date): Promise<void> {
  await backfillAcceptance(clientId, intakeId, email, raw, receivedAt)
}

async function backfillAcceptance(clientId: string | null, intakeId: string, email: string | null, raw: unknown, receivedAt: Date): Promise<void> {
  const parsed = parseAcceptance(raw, receivedAt.toISOString())
  for (const a of parsed) {
    const exists = await prisma.serviceAcknowledgement.findFirst({ where: { intakeId, kind: a.kind, version: a.version }, select: { id: true } })
    if (exists) continue
    await prisma.serviceAcknowledgement.create({
      data: {
        clientId,
        intakeId,
        email,
        kind: a.kind,
        version: a.version,
        acceptedAt: new Date(a.acceptedAt),
        ip: a.ip,
        userAgent: a.userAgent,
        source: 'intake',
        contentHash: acknowledgementHash({ kind: a.kind, version: a.version, acceptedAt: a.acceptedAt, ip: a.ip, userAgent: a.userAgent, email }),
      },
    })
  }
}

export function noticeHash(n: { kind: string; channel: string; to: string; subject: string | null; body: string; sentAt: string }): string {
  return sha256(`${n.kind}|${n.channel}|${n.to}|${n.subject ?? ''}|${n.body}|${n.sentAt}`)
}
