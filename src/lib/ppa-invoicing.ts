/**
 * PPA bi-weekly invoicing automation.
 *
 * Once daily, the scheduler calls processPpaInvoicingForAllClients()
 * which walks every active PPA client and, if their cycle is due
 * (lastInvoicedAt OR serviceStartDate is >= 14 days ago), tallies
 * the qualified appointments since the last invoice and fires an
 * email + SMS with the matching QuickBooks payment link.
 *
 * Definition of "qualified appointment" for invoicing (per Alex
 * 2026-06-01):
 *   - Belongs to this client (Appointment.clientId)
 *   - The CLIENT (not Mary, not Yassin) updated the status from
 *     their /client dashboard. Encoded as
 *     clientStatusUpdatedAt IS NOT NULL.
 *   - That status is one of {showed, won, lost} — all imply the
 *     prospect attended.
 *   - The status update happened AFTER invoicingCutoffAt (so
 *     pre-deploy updates don't get re-invoiced) AND after the
 *     last invoice cycle anchor (lastInvoicedAt or
 *     serviceStartDate).
 *   - Not already counted in an existing Invoice.appointmentIds
 *     (idempotency belt).
 *   - customerDisqualified is IGNORED for billing — per Alex, the
 *     client pays for any show-up regardless of in-meeting DQ.
 *
 * Overflow rule: if a cycle has more qualified appts than we have
 * payment links for (currently >4), the automation does NOT send
 * an invoice. Instead it records an Invoice row with deliveryError
 * = 'overflow' and fires a Slack alert listing the appointments so
 * Alex can build a manual invoice. lastInvoicedAt still advances
 * so the cron doesn't spam alerts every day.
 *
 * Empty cycles (0 qualified appts after 14 days): no invoice, no
 * Invoice row, no email, no SMS — just a silent advance of
 * lastInvoicedAt and a debug log line. We don't want to mail
 * clients saying "you owe nothing"; that's noise.
 *
 * Idempotency: each successful run wraps the Invoice create +
 * lastInvoicedAt update in a single transaction, so a duplicate
 * scheduler tick sees the advanced timestamp and bails. The
 * outer cron tick uses a per-process "in flight" lock too as
 * belt-and-suspenders (see scheduler.ts wiring).
 */

import { prisma } from './prisma'
import { sendEmail } from './gmail'
import { sendSmsToPhone } from './ghl'
import { postChannelMessage, resolveChannelIdByName, formatSlackError } from './slack'
import {
  PPA_CYCLE_LENGTH_MS,
  PPA_MAX_LINK_COUNT,
  PPA_PAYMENT_LINKS,
  PPA_PRICE_PER_APPOINTMENT_CENTS,
  formatUsd,
} from './ppa-invoicing-config'

const SMS_VAULT_ENTRY = 'GHL Genisys Token'
const ALERTS_CHANNEL_NAME =
  process.env.PPA_INVOICING_ALERT_CHANNEL?.trim() || 'genisys-alerts'

/** From email account — same Gmail mailbox the welcome / onboarding
 *  flows use so all client-facing mail comes from one identity. */
const FROM_GMAIL_ACCOUNT =
  process.env.PPA_INVOICING_FROM_EMAIL ||
  process.env.AGENT_APPROVAL_FROM_EMAIL ||
  'alex@leadgenisys.com'

export type InvoiceRunResult = {
  clientsChecked: number
  clientsInvoiced: number
  clientsOverflowed: number
  clientsEmpty: number
  errors: Array<{ clientId: string; clientName: string; error: string }>
}

/**
 * Daily entry point — walk every PPA client and process anyone due.
 * Sequential rather than parallel: bcrypt and Gmail / GHL send are
 * each non-trivial, and serializing N≤25 clients keeps the whole
 * run under a minute without risking rate limits.
 */
export async function processPpaInvoicingForAllClients(): Promise<InvoiceRunResult> {
  // Kill switch — flip the env var to true in an active incident
  // (mis-priced links, wrong template, whatever) without a deploy.
  if (
    (process.env.PPA_INVOICING_DISABLED || '').toLowerCase() === 'true'
  ) {
    console.log('[ppa-invoicing] disabled via env, skipping run')
    return {
      clientsChecked: 0,
      clientsInvoiced: 0,
      clientsOverflowed: 0,
      clientsEmpty: 0,
      errors: [],
    }
  }

  const clients = await prisma.client.findMany({
    where: {
      package: 'ppa',
      active: true,
      lifecycle: 'active',
    },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      contactName: true,
      contactEmail: true,
      contactPhone: true,
      serviceStartDate: true,
      invoicingCutoffAt: true,
      lastInvoicedAt: true,
    },
  })

  const result: InvoiceRunResult = {
    clientsChecked: 0,
    clientsInvoiced: 0,
    clientsOverflowed: 0,
    clientsEmpty: 0,
    errors: [],
  }

  for (const client of clients) {
    result.clientsChecked++
    try {
      const outcome = await processPpaInvoicingForClient(client.id)
      if (outcome.kind === 'invoiced') result.clientsInvoiced++
      else if (outcome.kind === 'overflow') result.clientsOverflowed++
      else if (outcome.kind === 'empty') result.clientsEmpty++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result.errors.push({
        clientId: client.id,
        clientName: client.name,
        error: message,
      })
      console.error(
        `[ppa-invoicing] client ${client.name} (${client.id}) failed:`,
        err,
      )
    }
  }

  return result
}

type PerClientOutcome =
  | { kind: 'not_due' }
  | { kind: 'no_start_date' }
  | { kind: 'empty'; cycleStart: Date; cycleEnd: Date }
  | { kind: 'invoiced'; invoiceId: string; count: number }
  | { kind: 'overflow'; invoiceId: string; count: number }

/**
 * Per-client processing. Public so the upcoming
 * /api/admin/ppa-invoicing/run-now endpoint can target a specific
 * client for testing without waiting on the daily tick.
 */
export async function processPpaInvoicingForClient(
  clientId: string,
): Promise<PerClientOutcome> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      name: true,
      contactName: true,
      contactEmail: true,
      contactPhone: true,
      package: true,
      active: true,
      lifecycle: true,
      serviceStartDate: true,
      invoicingCutoffAt: true,
      lastInvoicedAt: true,
    },
  })
  if (
    !client ||
    !client.active ||
    client.lifecycle !== 'active' ||
    client.package !== 'ppa'
  ) {
    return { kind: 'not_due' }
  }
  if (!client.serviceStartDate) {
    // No start date means we don't know when the cycle anchor is.
    // Legacy migration backfilled all existing PPA clients, so this
    // should only happen for freshly-created rows whose onboarding
    // hasn't finished yet — those aren't actually billable.
    return { kind: 'no_start_date' }
  }

  // Cycle anchor = whichever's later. lastInvoicedAt wins after
  // the first cycle; serviceStartDate is the bootstrap.
  const cycleAnchor =
    client.lastInvoicedAt && client.lastInvoicedAt > client.serviceStartDate
      ? client.lastInvoicedAt
      : client.serviceStartDate
  const cycleEnd = new Date(cycleAnchor.getTime() + PPA_CYCLE_LENGTH_MS)
  const now = new Date()
  if (now < cycleEnd) {
    return { kind: 'not_due' }
  }

  // Find qualified appointments since cycle anchor. The cutoff
  // filter is a belt on top of the anchor — cutoff is set to
  // deploy-time on existing clients to absolutely guarantee old
  // status updates can't slip in even if the math goes wrong.
  const lowerBound =
    client.invoicingCutoffAt && client.invoicingCutoffAt > cycleAnchor
      ? client.invoicingCutoffAt
      : cycleAnchor

  // Already-billed appointment ids — accumulated from every prior
  // Invoice row for this client. Used as a defense-in-depth filter
  // on top of the time-window filter so a manually-edited
  // appointment can't get re-billed.
  const priorInvoices = await prisma.invoice.findMany({
    where: { clientId: client.id },
    select: { appointmentIds: true },
  })
  const alreadyBilled = new Set<string>()
  for (const inv of priorInvoices) {
    const ids = Array.isArray(inv.appointmentIds)
      ? (inv.appointmentIds as unknown[])
      : []
    for (const id of ids) {
      if (typeof id === 'string') alreadyBilled.add(id)
    }
  }

  const qualified = await prisma.appointment.findMany({
    where: {
      clientId: client.id,
      clientStatusUpdatedAt: { gt: lowerBound },
      status: { in: ['showed', 'won', 'lost'] },
    },
    orderBy: { apptDateTime: 'asc' },
    select: {
      id: true,
      apptDateTime: true,
      customerName: true,
      customerPhone: true,
      address: true,
      monthlyBill: true,
      utilityProvider: true,
      bookedByName: true,
      status: true,
      clientStatusUpdatedAt: true,
    },
  })
  const newlyQualified = qualified.filter((a) => !alreadyBilled.has(a.id))
  const count = newlyQualified.length

  if (count === 0) {
    // Empty cycle — advance lastInvoicedAt anyway so we don't
    // re-check this client tomorrow and the day after, etc. No
    // Invoice row created (we don't want a noise audit trail for
    // "checked, found nothing").
    await prisma.client.update({
      where: { id: client.id },
      data: { lastInvoicedAt: now },
    })
    console.log(
      `[ppa-invoicing] ${client.name} cycle complete with 0 qualified appts — advanced lastInvoicedAt to ${now.toISOString()}`,
    )
    return { kind: 'empty', cycleStart: cycleAnchor, cycleEnd: now }
  }

  // Overflow — we don't have a pre-built link big enough. Per Alex:
  // record the Invoice row, advance lastInvoicedAt so we don't spam
  // daily alerts, and fire a Slack message so admin can handle the
  // manual send. The client themselves DOES NOT receive an email
  // or SMS in this case.
  if (count > PPA_MAX_LINK_COUNT) {
    const invoice = await prisma.$transaction(async (tx) => {
      const created = await tx.invoice.create({
        data: {
          clientId: client.id,
          cycleStartAt: cycleAnchor,
          cycleEndAt: now,
          appointmentCount: count,
          appointmentIds: newlyQualified.map((a) => a.id),
          amountCents: count * PPA_PRICE_PER_APPOINTMENT_CENTS,
          paymentLink: '',
          deliveryError: 'overflow',
        },
        select: { id: true },
      })
      await tx.client.update({
        where: { id: client.id },
        data: { lastInvoicedAt: now },
      })
      return created
    })
    await sendOverflowSlackAlert({
      clientName: client.name,
      count,
      appointments: newlyQualified,
    })
    console.log(
      `[ppa-invoicing] ${client.name} OVERFLOW with ${count} qualified appts (max link is ${PPA_MAX_LINK_COUNT}) — manual invoice required`,
    )
    return { kind: 'overflow', invoiceId: invoice.id, count }
  }

  // Standard path — fire the invoice.
  const paymentLink = PPA_PAYMENT_LINKS[count]
  if (!paymentLink) {
    // Shouldn't be reachable (overflow branch above) but defensive
    // log in case PPA_PAYMENT_LINKS gets edited weirdly.
    throw new Error(
      `No payment link configured for count=${count}. Check PPA_PAYMENT_LINKS.`,
    )
  }
  const amountCents = count * PPA_PRICE_PER_APPOINTMENT_CENTS

  // Compose email + SMS bodies BEFORE the DB write so a template
  // bug throws cleanly without leaving an orphan Invoice row.
  const emailHtml = formatInvoiceEmail({
    clientName: client.name,
    contactName: client.contactName,
    count,
    amountCents,
    paymentLink,
    cycleStart: cycleAnchor,
    cycleEnd: now,
    appointments: newlyQualified,
  })
  const smsBody = formatInvoiceSms({
    contactName: client.contactName,
    count,
    amountCents,
    paymentLink,
  })

  // Single transaction for Invoice + lastInvoicedAt advance.
  // Delivery (email + SMS) happens AFTER commit so a Gmail blip
  // can't roll back the bookkeeping — we'd rather have an
  // Invoice row with deliveryError set (admin can retry from
  // Slack alert) than risk double-billing on a re-run.
  const invoice = await prisma.$transaction(async (tx) => {
    const created = await tx.invoice.create({
      data: {
        clientId: client.id,
        cycleStartAt: cycleAnchor,
        cycleEndAt: now,
        appointmentCount: count,
        appointmentIds: newlyQualified.map((a) => a.id),
        amountCents,
        paymentLink,
      },
      select: { id: true },
    })
    await tx.client.update({
      where: { id: client.id },
      data: { lastInvoicedAt: now },
    })
    return created
  })

  // Delivery — both fire-and-track. Failures stamp deliveryError
  // on the Invoice row so admin can audit later. NOT thrown; the
  // function returns 'invoiced' as long as the DB row got created.
  let emailSentAt: Date | null = null
  let smsSentAt: Date | null = null
  const failureNotes: string[] = []

  if (client.contactEmail?.trim()) {
    try {
      await sendEmail({
        accountEmail: FROM_GMAIL_ACCOUNT,
        to: client.contactEmail.trim(),
        subject: `Invoice from Lead Genisys — ${count} qualified appointment${count === 1 ? '' : 's'} (${formatUsd(amountCents)})`,
        body: emailHtml,
        fromName: 'Genisys',
      })
      emailSentAt = new Date()
    } catch (err) {
      failureNotes.push(
        `email: ${err instanceof Error ? err.message : String(err)}`,
      )
      console.error(
        `[ppa-invoicing] email failed for ${client.name}:`,
        err,
      )
    }
  } else {
    failureNotes.push('email: no contactEmail on file')
  }

  if (client.contactPhone?.trim()) {
    try {
      await sendSmsToPhone(SMS_VAULT_ENTRY, {
        phone: client.contactPhone.trim(),
        message: smsBody,
        companyName: client.name,
        ...(client.contactName ? splitName(client.contactName) : {}),
      })
      smsSentAt = new Date()
    } catch (err) {
      failureNotes.push(
        `sms: ${err instanceof Error ? err.message : String(err)}`,
      )
      console.error(
        `[ppa-invoicing] sms failed for ${client.name}:`,
        err,
      )
    }
  } else {
    failureNotes.push('sms: no contactPhone on file')
  }

  // Stamp delivery results back onto the Invoice row.
  await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      emailSentAt,
      smsSentAt,
      deliveryError: failureNotes.length > 0 ? failureNotes.join('; ') : null,
    },
  })

  await sendInvoiceFiredSlackAlert({
    clientName: client.name,
    count,
    amountCents,
    appointments: newlyQualified,
    emailSent: !!emailSentAt,
    smsSent: !!smsSentAt,
    failureNotes,
  })

  console.log(
    `[ppa-invoicing] ${client.name} invoiced ${count} qualified appts for ${formatUsd(amountCents)} (email=${!!emailSentAt} sms=${!!smsSentAt})`,
  )
  return { kind: 'invoiced', invoiceId: invoice.id, count }
}

/* -------------------------------------------------------------------------- */
/*  Slack alerts                                                              */
/* -------------------------------------------------------------------------- */

async function sendInvoiceFiredSlackAlert(opts: {
  clientName: string
  count: number
  amountCents: number
  appointments: Array<{
    apptDateTime: Date
    customerName: string
    address: string | null
  }>
  emailSent: boolean
  smsSent: boolean
  failureNotes: string[]
}): Promise<void> {
  const lines = [
    `:receipt: *Invoice fired — ${opts.clientName}*`,
    `${opts.count} qualified appointment${opts.count === 1 ? '' : 's'} · *${formatUsd(opts.amountCents)}*`,
    '',
    ...opts.appointments.map((a) => {
      const when = a.apptDateTime.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      })
      const addr = a.address ? ` · ${a.address}` : ''
      return `• ${when} · ${a.customerName}${addr}`
    }),
    '',
    `Email: ${opts.emailSent ? ':white_check_mark: sent' : ':x: failed'}  ·  SMS: ${opts.smsSent ? ':white_check_mark: sent' : ':x: failed'}`,
    ...(opts.failureNotes.length > 0
      ? ['', `_Delivery notes:_ ${opts.failureNotes.join(' / ')}`]
      : []),
  ].join('\n')
  await postToInvoicingChannel(lines)
}

async function sendOverflowSlackAlert(opts: {
  clientName: string
  count: number
  appointments: Array<{
    apptDateTime: Date
    customerName: string
    address: string | null
  }>
}): Promise<void> {
  const lines = [
    `:warning: *Invoice OVERFLOW — manual send required for ${opts.clientName}*`,
    `${opts.count} qualified appointments this cycle, but we only have payment links up to ${PPA_MAX_LINK_COUNT}. Please send a manual invoice for the appointments below.`,
    '',
    ...opts.appointments.map((a) => {
      const when = a.apptDateTime.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      })
      const addr = a.address ? ` · ${a.address}` : ''
      return `• ${when} · ${a.customerName}${addr}`
    }),
    '',
    `Approximate total at standard rate: *${formatUsd(opts.count * PPA_PRICE_PER_APPOINTMENT_CENTS)}*`,
    '',
    `lastInvoicedAt has been advanced so the cron won't keep re-alerting. Once you've sent the manual invoice, this cycle is closed — the next automated invoice fires ~14 days from now.`,
  ].join('\n')
  await postToInvoicingChannel(lines)
}

async function postToInvoicingChannel(text: string): Promise<void> {
  try {
    const channelId = await resolveChannelIdByName(ALERTS_CHANNEL_NAME)
    if (!channelId) {
      console.warn(
        `[ppa-invoicing] alert channel #${ALERTS_CHANNEL_NAME} not visible to the bot — alert dropped`,
      )
      return
    }
    await postChannelMessage(channelId, text)
  } catch (err) {
    console.error(
      '[ppa-invoicing] Slack alert post failed:',
      formatSlackError(err),
    )
  }
}

/* -------------------------------------------------------------------------- */
/*  Email + SMS templates                                                     */
/* -------------------------------------------------------------------------- */

function escHtml(s: string | null | undefined): string {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatInvoiceEmail(params: {
  clientName: string
  contactName: string | null
  count: number
  amountCents: number
  paymentLink: string
  cycleStart: Date
  cycleEnd: Date
  appointments: Array<{
    apptDateTime: Date
    customerName: string
    customerPhone: string
    address: string | null
    monthlyBill: string | null
    utilityProvider: string | null
    bookedByName: string | null
  }>
}): string {
  const greetingName = params.contactName?.trim()
    ? params.contactName.trim().split(/\s+/)[0]
    : 'there'

  const cycleStartLabel = params.cycleStart.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
  const cycleEndLabel = params.cycleEnd.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })

  const rows = params.appointments
    .map((a) => {
      const when = a.apptDateTime.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      })
      const detailsParts = [
        a.utilityProvider,
        a.monthlyBill ? `$${a.monthlyBill}/mo bill` : null,
        a.bookedByName ? `booked by ${a.bookedByName}` : null,
      ].filter(Boolean) as string[]
      const details = detailsParts.length > 0 ? detailsParts.join(' · ') : '—'
      return `
        <tr>
          <td style="padding:10px 8px;border-top:1px solid #e5e7eb;font-size:13px;vertical-align:top;">
            <div style="font-weight:600;color:#111827;">${escHtml(a.customerName)}</div>
            <div style="color:#6b7280;font-size:12px;margin-top:2px;">${escHtml(a.customerPhone)}</div>
          </td>
          <td style="padding:10px 8px;border-top:1px solid #e5e7eb;font-size:13px;color:#374151;vertical-align:top;">
            ${escHtml(when)}
          </td>
          <td style="padding:10px 8px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;vertical-align:top;">
            ${a.address ? escHtml(a.address) : '<span style="color:#9ca3af;">—</span>'}
          </td>
          <td style="padding:10px 8px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;vertical-align:top;">
            ${escHtml(details)}
          </td>
        </tr>
      `
    })
    .join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Invoice from Lead Genisys</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f3f4f6;padding:24px 0;">
    <tr>
      <td align="center">
        <table cellpadding="0" cellspacing="0" border="0" width="640" style="max-width:640px;width:100%;background:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.06);overflow:hidden;">
          <tr>
            <td style="background:#1e3a8a;padding:22px 28px;color:#ffffff;">
              <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.12em;opacity:0.7;">Lead Genisys · Invoice</div>
              <div style="font-size:22px;font-weight:700;margin-top:4px;">${escHtml(params.clientName)}</div>
              <div style="font-size:13px;margin-top:4px;opacity:0.9;">${escHtml(cycleStartLabel)} – ${escHtml(cycleEndLabel)}</div>
            </td>
          </tr>

          <tr>
            <td style="padding:24px 28px 8px 28px;">
              <p style="margin:0 0 14px 0;font-size:15px;line-height:1.6;color:#374151;">
                Hi ${escHtml(greetingName)},
              </p>
              <p style="margin:0 0 14px 0;font-size:15px;line-height:1.6;color:#374151;">
                Here's your bi-weekly invoice from Lead Genisys for the <strong>${params.count} qualified appointment${params.count === 1 ? '' : 's'}</strong> we delivered to you this cycle. Every appointment below is one you confirmed showed up via your client dashboard.
              </p>

              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:18px 0;border-collapse:collapse;">
                <tr>
                  <td style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:16px 18px;">
                    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
                      <tr>
                        <td style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;">Qualified appointments</td>
                        <td style="text-align:right;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;">Total due</td>
                      </tr>
                      <tr>
                        <td style="padding-top:4px;font-size:24px;font-weight:700;color:#111827;">${params.count}</td>
                        <td style="text-align:right;padding-top:4px;font-size:24px;font-weight:700;color:#111827;">${escHtml(formatUsd(params.amountCents))}</td>
                      </tr>
                      <tr>
                        <td style="padding-top:4px;font-size:11px;color:#6b7280;">at ${escHtml(formatUsd(PPA_PRICE_PER_APPOINTMENT_CENTS))} per appointment</td>
                        <td></td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <div style="margin:18px 0 6px 0;">
                <a href="${escHtml(params.paymentLink)}"
                   style="display:inline-block;background:#1e3a8a;color:#ffffff;text-decoration:none;padding:13px 28px;border-radius:8px;font-size:15px;font-weight:600;">
                  Pay invoice now
                </a>
              </div>
              <p style="margin:6px 0 18px 0;font-size:12px;color:#6b7280;">
                Or copy this link into your browser:<br>
                <a href="${escHtml(params.paymentLink)}" style="color:#1e3a8a;word-break:break-all;">${escHtml(params.paymentLink)}</a>
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:6px 28px 24px 28px;">
              <h3 style="margin:18px 0 8px 0;font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:#6b7280;font-weight:700;">Appointments included in this invoice</h3>
              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
                <thead>
                  <tr style="background:#f9fafb;">
                    <th style="text-align:left;padding:10px 8px;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;">Customer</th>
                    <th style="text-align:left;padding:10px 8px;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;">Appointment</th>
                    <th style="text-align:left;padding:10px 8px;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;">Address</th>
                    <th style="text-align:left;padding:10px 8px;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;">Details</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows}
                </tbody>
              </table>

              <p style="margin:24px 0 0 0;font-size:13px;line-height:1.6;color:#6b7280;">
                Questions about any of these appointments? Just reply to this email and we'll dig in. You can also see the full delivery history any time in your <a href="https://genisys-hub.onrender.com/signin/client" style="color:#1e3a8a;">Genisys client portal</a>.
              </p>
              <p style="margin:18px 0 0 0;font-size:13px;line-height:1.6;color:#374151;">
                Thanks for working with us,<br>
                <strong>The Genisys team</strong>
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:18px 28px;background:#f9fafb;border-top:1px solid #e5e7eb;color:#6b7280;font-size:11px;line-height:1.5;">
              This invoice was generated automatically from the appointments you marked as "showed up" between ${escHtml(cycleStartLabel)} and ${escHtml(cycleEndLabel)}. Lead Genisys · PPA cycle invoice.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

function formatInvoiceSms(params: {
  contactName: string | null
  count: number
  amountCents: number
  paymentLink: string
}): string {
  const greetingName = params.contactName?.trim()
    ? params.contactName.trim().split(/\s+/)[0]
    : 'there'
  return [
    `Hi ${greetingName} — your Lead Genisys invoice for ${params.count} qualified appointment${params.count === 1 ? '' : 's'} (${formatUsd(params.amountCents)}) is ready.`,
    `Pay here: ${params.paymentLink}`,
    `Full breakdown is in your email.`,
  ].join(' ')
}

function splitName(raw: string): {
  firstName?: string
  lastName?: string
} {
  const trimmed = raw.trim()
  if (!trimmed) return {}
  const parts = trimmed.split(/\s+/)
  if (parts.length === 1) return { firstName: parts[0] }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
  }
}
