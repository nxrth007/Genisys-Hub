/**
 * Receipts, open pixels, and the optional milestone confirmation.
 * Open tracking defaults on for mail the Hub already sends. Milestone
 * links and extra onboarding emails stay off until config turns them on.
 * A mail scanner can prefetch the pixel; the packet says so.
 */
import { randomBytes } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { sendEmail } from '@/lib/gmail'
import { rememberedMemberByEmail } from '@/lib/stripe-onboarding'
import { stampMetadata } from './stripe'
import { pdfBytes, renderEvidencePdf } from './pdf'
import { acknowledgementHash, allowsStripeWrite, redactCredentialLinks, sha256, type DisputeConfig } from './plan'
import { captureIntakeAcceptance, noticeHash, writeLedger } from './ledger'
import { loadDisputeConfig } from './config'
import { syncSetupMilestones } from './setup'

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

export function pixelGif(): Buffer {
  return GIF
}

function baseUrl(): string {
  return (process.env.AUTH_URL || 'https://genisys-hub.onrender.com').replace(/\/$/, '')
}

export function withOpenPixel(html: string, url: string): string {
  const img = `<img src="${url}" width="1" height="1" alt="" style="display:block;width:1px;height:1px" />`
  return html.includes('</body>') ? html.replace('</body>', `${img}</body>`) : html + img
}

/**
 * Record an email we are about to send and, when open tracking is on,
 * return the HTML with a pixel. Failures return the original HTML so
 * the send still happens.
 */
export async function prepareTrackedEmail(o: {
  config: DisputeConfig
  clientId: string | null
  kind: string
  to: string
  subject: string
  html: string
  sourceId: string
}): Promise<string> {
  const sentAt = new Date()
  const bodyHash = sha256(o.html)
  let tokenHash: string | null = null
  let html = o.html
  if (o.config.openTracking) {
    const token = randomBytes(24).toString('hex')
    tokenHash = sha256(token)
    html = withOpenPixel(o.html, `${baseUrl()}/api/public/receipts/${token}`)
  }
  try {
    await prisma.deliveryReceipt.create({
      data: {
        clientId: o.clientId,
        kind: o.kind,
        channel: 'email',
        toAddress: o.to,
        subject: o.subject,
        tokenHash,
        sentAt,
        bodyHash,
        sourceId: o.sourceId,
      },
    })
  } catch (err) {
    if (!isUnique(err)) throw err
    return o.html
  }
  return html
}

export async function recordSmsReceipt(o: { clientId: string | null; kind: string; to: string; body: string; sourceId: string }): Promise<void> {
  const sentAt = new Date()
  try {
    await prisma.deliveryReceipt.create({
      data: {
        clientId: o.clientId,
        kind: o.kind,
        channel: 'sms',
        toAddress: o.to,
        subject: null,
        sentAt,
        deliveredAt: sentAt,
        bodyHash: sha256(o.body),
        sourceId: o.sourceId,
      },
    })
  } catch (err) {
    if (!isUnique(err)) throw err
  }
}

export async function markReceiptOpen(token: string, ip: string | null, userAgent: string | null): Promise<void> {
  const tokenHash = sha256(token)
  const row = await prisma.deliveryReceipt.findUnique({ where: { tokenHash }, select: { id: true, openedAt: true, openCount: true } })
  if (!row) return
  await prisma.deliveryReceipt.update({
    where: { id: row.id },
    data: {
      openedAt: row.openedAt ?? new Date(),
      openCount: row.openCount + 1,
      lastOpenIp: ip,
      lastOpenUa: userAgent?.slice(0, 300) ?? null,
    },
  })
}

export async function recordStripeNotice(o: {
  clientId: string | null
  email: string | null
  amountCents: number | null
  currency: string
  chargeId: string | null
  invoiceId: string | null
}): Promise<void> {
  const sentAt = new Date()
  const body = `Stripe collected ${o.amountCents === null ? 'a payment' : `${(o.amountCents / 100).toFixed(2)} ${o.currency.toUpperCase()}`} on invoice ${o.invoiceId ?? 'unknown'}.`
  const hash = noticeHash({ kind: 'receipt', channel: 'stripe', to: o.email ?? '', subject: 'Stripe payment', body, sentAt: sentAt.toISOString() })
  const source = o.invoiceId ?? o.chargeId
  if (source) {
    const dup = await prisma.serviceNotice.findFirst({ where: { stripeChargeId: o.chargeId, kind: 'receipt', channel: 'stripe' }, select: { id: true } })
    if (dup && o.chargeId) return
  }
  await prisma.serviceNotice.create({
    data: {
      clientId: o.clientId,
      kind: 'receipt',
      channel: 'stripe',
      toAddress: o.email ?? 'stripe customer',
      subject: 'Stripe payment',
      body,
      stripeChargeId: o.chargeId,
      contentHash: hash,
      sentAt,
    },
  })
}

/** Optional onboarding email and milestone link. Both switches default off. */
export async function maybeSendOnboardingNotice(o: {
  config: DisputeConfig
  clientId: string
  intakeId: string
  email: string | null
  name: string
}): Promise<void> {
  if (!o.config.clientNotices || !o.email) return
  let milestoneUrl: string | null = null
  if (o.config.milestoneAck) milestoneUrl = await issueMilestone(o.clientId, 'service_started')
  const subject = 'Lead Genisys — we received your onboarding'
  const html = `<!DOCTYPE html><html><body style="font-family:sans-serif;color:#111">
<p>Hi ${escapeHtml(o.name)},</p>
<p>We received your onboarding and started setting up lead generation and marketing for your business. This note confirms the service has started.</p>
${milestoneUrl ? `<p><a href="${milestoneUrl}">Confirm service started</a></p>` : ''}
<p>Lead Genisys</p>
</body></html>`
  const from = process.env.PPA_INVOICING_FROM_EMAIL || process.env.AGENT_APPROVAL_FROM_EMAIL || 'alex@leadgenisys.com'
  const tracked = await prepareTrackedEmail({ config: o.config, clientId: o.clientId, kind: 'onboarding', to: o.email, subject, html, sourceId: `onboarding:${o.intakeId}` }).catch(() => html)
  await sendEmail({ accountEmail: from, to: o.email, subject, body: tracked, fromName: 'Lead Genisys' })
  const sentAt = new Date().toISOString()
  await prisma.serviceNotice.create({
    data: {
      clientId: o.clientId,
      kind: 'onboarding',
      channel: 'email',
      toAddress: o.email,
      subject,
      body: 'Onboarding confirmation sent.',
      contentHash: noticeHash({ kind: 'onboarding', channel: 'email', to: o.email, subject, body: 'Onboarding confirmation sent.', sentAt }),
    },
  })
}

export async function issueMilestone(clientId: string, kind: string): Promise<string> {
  const token = randomBytes(24).toString('hex')
  await prisma.serviceMilestone.create({ data: { clientId, kind, tokenHash: sha256(token) } })
  return `${baseUrl()}/api/public/acknowledge/${token}`
}

export async function confirmMilestone(token: string, ip: string | null, userAgent: string | null): Promise<{ ok: boolean; already: boolean }> {
  const row = await prisma.serviceMilestone.findUnique({ where: { tokenHash: sha256(token) } })
  if (!row) return { ok: false, already: false }
  if (row.status === 'confirmed') return { ok: true, already: true }
  const confirmedAt = new Date()
  const claimed = await prisma.serviceMilestone.updateMany({
    where: { id: row.id, status: 'pending' },
    data: { status: 'confirmed', confirmedAt, ip, userAgent: userAgent?.slice(0, 300) ?? null },
  })
  if (claimed.count !== 1) return { ok: true, already: true }
  const acceptedAt = confirmedAt.toISOString()
  await prisma.serviceAcknowledgement.create({
    data: {
      clientId: row.clientId,
      kind: 'milestone',
      version: row.kind,
      acceptedAt: confirmedAt,
      ip,
      userAgent: userAgent?.slice(0, 300) ?? null,
      source: 'milestone',
      contentHash: acknowledgementHash({ kind: 'milestone', version: row.kind, acceptedAt, ip, userAgent, email: null }),
    },
  })
  return { ok: true, already: false }
}

/**
 * Log a client-report send: open pixel, delivery receipt, HTML and PDF
 * snapshots, a ledger line, and (when a login was included) a credential
 * delivery event that does not contain the password or the set-password link.
 * Returns the HTML to actually send (pixel added, link intact).
 */
export async function trackClientReport(o: {
  clientId: string
  to: string
  by: string
  subject: string
  html: string
  summary: string
  loginIncluded: boolean
  loginEmail: string | null
}): Promise<string> {
  const config = await loadDisputeConfig()
  const sourceId = `client-report:${o.clientId}:${Date.now()}`
  const html = await prepareTrackedEmail({
    config,
    clientId: o.clientId,
    kind: 'report',
    to: o.to,
    subject: o.subject,
    html: o.html,
    sourceId,
  }).catch(() => o.html)
  const stored = redactCredentialLinks(html)
  const sentAt = new Date()
  const pdf = renderEvidencePdf([
    { heading: 'Client report', body: `${o.subject}\nTo: ${o.to}\nSent by: ${o.by}\n${sentAt.toISOString()}` },
    { heading: 'What the email said', body: o.summary },
    {
      heading: 'Dashboard login',
      body: o.loginIncluded
        ? `A password-choice link was included for ${o.loginEmail ?? o.to}. The password is not stored. The link itself is not stored.`
        : 'This send did not include a dashboard login.',
    },
  ])
  const notice = await prisma.serviceNotice.create({
    data: {
      clientId: o.clientId,
      kind: 'report',
      channel: 'email',
      toAddress: o.to,
      subject: o.subject,
      body: stored.slice(0, 120_000),
      contentHash: noticeHash({ kind: 'report', channel: 'email', to: o.to, subject: o.subject, body: stored.slice(0, 4000), sentAt: sentAt.toISOString() }),
      snapshotSha256: sha256(stored),
      snapshotPdf: pdfBytes(pdf),
      sentAt,
    },
  })
  await writeLedger([
    {
      clientId: o.clientId,
      kind: 'client_report',
      title: `Client report emailed to ${o.to}`,
      detail: `${o.summary} Snapshot ${notice.snapshotSha256}. Sent by ${o.by}.`,
      occurredAt: sentAt,
      source: 'client_report',
      sourceId: notice.id,
    },
    ...(o.loginIncluded
      ? [
          {
            clientId: o.clientId,
            kind: 'login_invite',
            title: `Dashboard login invite sent to ${o.loginEmail ?? o.to}`,
            detail: 'The client sets their own password. The password and the set-password link are not stored.',
            occurredAt: sentAt,
            source: 'login_invite',
            sourceId: notice.id,
          },
        ]
      : []),
  ])
  return html
}

/** Clickwrap from an onboarding body, plus the optional confirmation email. */
export async function afterIntake(o: { intakeId: string; clientId: string | null; email: string | null; name: string; raw: unknown; receivedAt: Date }): Promise<void> {
  await captureIntakeAcceptance(o.clientId, o.intakeId, o.email, o.raw, o.receivedAt)
  if (!o.clientId) return
  const config = await loadDisputeConfig()
  await maybeSendOnboardingNotice({ config, clientId: o.clientId, intakeId: o.intakeId, email: o.email, name: o.name }).catch((err) => {
    console.error('[disputes] onboarding notice:', err instanceof Error ? err.message : 'failed')
  })
  await syncSetupMilestones(o.clientId).catch(() => {})
  if (o.email && config.stampMetadata && allowsStripeWrite(config)) {
    const member = await rememberedMemberByEmail(o.email).catch(() => null)
    if (member?.customerId) {
      await stampMetadata('customers', member.customerId, { hub_client_id: o.clientId, hub_intake_id: o.intakeId }).catch(() => {})
    }
  }
}

function isUnique(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002'
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}
