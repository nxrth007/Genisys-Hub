import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { sendEmail } from '@/lib/gmail'
import { sendSmsToPhone } from '@/lib/ghl'

/**
 * POST /api/admin/invoices/[id]/resend
 *
 * Retry delivery for an existing Invoice row. Useful when the
 * original send failed (deliveryError set) or admin manually
 * updated a missing email/phone on the client and wants the
 * automation to deliver retroactively.
 *
 * Does NOT re-create the Invoice or change lastInvoicedAt — just
 * re-attempts email + SMS using the same payment link and the
 * client's CURRENT contact info. Updates emailSentAt / smsSentAt /
 * deliveryError on the Invoice row.
 *
 * Skipped for 'overflow' / 'missing_contact_info' invoices that
 * never had a payment link — admin must send those manually
 * through QuickBooks.
 */

const SMS_VAULT_ENTRY = 'GHL Genisys Token'
const FROM_GMAIL_ACCOUNT =
  process.env.PPA_INVOICING_FROM_EMAIL ||
  process.env.AGENT_APPROVAL_FROM_EMAIL ||
  'alex@leadgenisys.com'

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await params
  const invoice = await prisma.invoice.findUnique({
    where: { id },
    select: {
      id: true,
      paymentLink: true,
      appointmentCount: true,
      amountCents: true,
      cycleStartAt: true,
      cycleEndAt: true,
      appointmentIds: true,
      client: {
        select: {
          id: true,
          name: true,
          contactName: true,
          contactEmail: true,
          contactPhone: true,
        },
      },
    },
  })
  if (!invoice) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  if (!invoice.paymentLink) {
    return NextResponse.json(
      {
        error:
          'This invoice has no payment link (overflow or missing-contact case). Send manually through QuickBooks.',
      },
      { status: 409 },
    )
  }

  // Re-hydrate the appointment list for the email body.
  const ids = Array.isArray(invoice.appointmentIds)
    ? (invoice.appointmentIds as unknown[]).filter(
        (x): x is string => typeof x === 'string',
      )
    : []
  const appointments = await prisma.appointment.findMany({
    where: { id: { in: ids } },
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
    },
  })

  // Use the same template logic as the original send. Importing
  // helpers from the lib so we don't drift between first-send and
  // resend rendering.
  const { formatInvoiceEmail, formatInvoiceSms, splitName } = await import(
    '@/lib/ppa-invoicing'
  )

  const failureNotes: string[] = []
  let emailSentAt: Date | null = null
  let smsSentAt: Date | null = null

  if (invoice.client.contactEmail?.trim()) {
    try {
      await sendEmail({
        accountEmail: FROM_GMAIL_ACCOUNT,
        to: invoice.client.contactEmail.trim(),
        subject: `Invoice from Lead Genisys — ${invoice.appointmentCount} qualified appointment${invoice.appointmentCount === 1 ? '' : 's'}`,
        body: formatInvoiceEmail({
          clientName: invoice.client.name,
          contactName: invoice.client.contactName,
          count: invoice.appointmentCount,
          amountCents: invoice.amountCents,
          paymentLink: invoice.paymentLink,
          cycleStart: invoice.cycleStartAt,
          cycleEnd: invoice.cycleEndAt,
          appointments,
        }),
        fromName: 'Genisys',
      })
      emailSentAt = new Date()
    } catch (err) {
      failureNotes.push(
        `email: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  } else {
    failureNotes.push('email: no contactEmail on file')
  }

  if (invoice.client.contactPhone?.trim()) {
    try {
      await sendSmsToPhone(SMS_VAULT_ENTRY, {
        phone: invoice.client.contactPhone.trim(),
        message: formatInvoiceSms({
          contactName: invoice.client.contactName,
          count: invoice.appointmentCount,
          amountCents: invoice.amountCents,
          paymentLink: invoice.paymentLink,
        }),
        companyName: invoice.client.name,
        ...(invoice.client.contactName
          ? splitName(invoice.client.contactName)
          : {}),
      })
      smsSentAt = new Date()
    } catch (err) {
      failureNotes.push(
        `sms: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  } else {
    failureNotes.push('sms: no contactPhone on file')
  }

  await prisma.invoice.update({
    where: { id },
    data: {
      emailSentAt: emailSentAt ?? undefined,
      smsSentAt: smsSentAt ?? undefined,
      deliveryError:
        failureNotes.length > 0 ? failureNotes.join('; ') : null,
    },
  })

  return NextResponse.json({
    ok: true,
    emailSent: !!emailSentAt,
    smsSent: !!smsSentAt,
    failureNotes,
  })
}
