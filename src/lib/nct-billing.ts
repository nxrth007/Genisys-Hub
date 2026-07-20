import { randomBytes } from 'crypto'
import { prisma } from './prisma'
import { getSecretByName } from './vault-service'
import { postChannelMessage, resolveChannelIdByName } from './slack'

/**
 * NCT Media roofing-lead billing engine.
 *
 * NCT POSTs a lead → we charge the client's saved card off-session →
 * a separate sweep moves Stripe's available balance to Mercury so the
 * buffer is topped up before NCT charges the virtual card.
 *
 * The charge is chained to the webhook (it must be immediate). The
 * payout deliberately is NOT: a brand-new charge sits in Stripe's
 * *pending* balance for ~2 business days, and Instant Payout can only
 * draw on the *available* balance. Paying out per-lead would be paying
 * out money that isn't there. The Mercury buffer covers the one-day
 * gap; the sweep refills the buffer from whatever has settled.
 */

const STRIPE_BASE = 'https://api.stripe.com/v1'

type StripeResult = { ok: boolean; status: number; data: Record<string, unknown> }

async function stripeCall(
  path: string,
  method: 'GET' | 'POST',
  form?: Record<string, string | number | boolean | undefined>,
  idempotencyKey?: string,
): Promise<StripeResult> {
  const key = await getSecretByName('Stripe API Key')
  const body =
    method === 'POST'
      ? new URLSearchParams(
          Object.entries(form ?? {})
            .filter(([, v]) => v !== undefined && v !== '')
            .map(([k, v]) => [k, String(v)]),
        )
      : undefined
  const res = await fetch(`${STRIPE_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body,
    cache: 'no-store',
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { ok: res.ok, status: res.status, data }
}

function stripeMessage(data: Record<string, unknown>, fallback: string): string {
  const err = data.error as { message?: string; code?: string } | undefined
  return err?.message || err?.code || fallback
}

/* -------------------------------------------------------------------------- */
/*  Settings                                                                  */
/* -------------------------------------------------------------------------- */

/** Get-or-create the singleton. Generates the webhook token on first read. */
export async function getNctSettings() {
  const existing = await prisma.nctBillingSettings.findUnique({
    where: { id: 'singleton' },
  })
  if (existing) return existing
  return prisma.nctBillingSettings.create({
    data: {
      id: 'singleton',
      webhookToken: randomBytes(24).toString('hex'),
      // Sensible default — the team already watches this channel.
      alertChannel: 'genisys-alerts',
    },
  })
}

export async function rotateNctWebhookToken() {
  await getNctSettings()
  return prisma.nctBillingSettings.update({
    where: { id: 'singleton' },
    data: { webhookToken: randomBytes(24).toString('hex') },
  })
}

/* -------------------------------------------------------------------------- */
/*  Payload parsing                                                           */
/* -------------------------------------------------------------------------- */

export type ParsedLead = {
  leadId: string | null
  name: string | null
  phone: string | null
  email: string | null
  address: string | null
  service: string | null
  sourceKey: string | null
}

function pick(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const hit = Object.keys(obj).find(
      (o) => o.toLowerCase().replace(/[\s_-]/g, '') === k,
    )
    if (hit) {
      const v = obj[hit]
      if (v !== null && v !== undefined && String(v).trim() !== '') {
        return String(v).trim()
      }
    }
  }
  return null
}

/**
 * Parse a "Name: X\nPhone: Y\n..." text blob — the exact shape NCT
 * posts into Slack today. Accepted so they can point the same message
 * template at the webhook without reformatting.
 */
function parseTextBlock(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z ]+?)\s*:\s*(.+?)\s*$/)
    if (m) out[m[1].trim()] = m[2].trim()
  }
  return out
}

export function parseLeadPayload(body: unknown): ParsedLead {
  let obj: Record<string, unknown> =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {}

  // Unwrap a couple of common envelope shapes, then fall back to text.
  if (typeof obj.lead === 'object' && obj.lead) {
    obj = { ...obj, ...(obj.lead as Record<string, unknown>) }
  }
  if (typeof obj.data === 'object' && obj.data) {
    obj = { ...obj, ...(obj.data as Record<string, unknown>) }
  }
  const textField = pick(obj, ['text', 'message', 'body', 'raw'])
  if (textField && textField.includes(':')) {
    obj = { ...parseTextBlock(textField), ...obj }
  }

  return {
    leadId: pick(obj, ['leadid', 'id', 'nctleadid', 'externalid']),
    name: pick(obj, ['name', 'fullname', 'leadname', 'customername']),
    phone: pick(obj, ['phone', 'phonenumber', 'mobile', 'cell']),
    email: pick(obj, ['email', 'emailaddress']),
    address: pick(obj, ['address', 'streetaddress', 'fulladdress']),
    service: pick(obj, ['service', 'servicetype', 'vertical', 'type']),
    sourceKey: pick(obj, ['sourcekey', 'client', 'clientkey', 'account']),
  }
}

/* -------------------------------------------------------------------------- */
/*  Weekly cap                                                                */
/* -------------------------------------------------------------------------- */

/** Monday 00:00 UTC of the current week — the cap's reset boundary. */
export function currentWeekStart(now = new Date()): Date {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  )
  const dow = d.getUTCDay() // 0 = Sun
  d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7))
  return d
}

export async function weeklyChargedCents(
  configId: string,
  now = new Date(),
): Promise<number> {
  const agg = await prisma.nctLead.aggregate({
    where: {
      configId,
      chargeStatus: 'charged',
      chargedAt: { gte: currentWeekStart(now) },
    },
    _sum: { amountCents: true },
  })
  return agg._sum.amountCents ?? 0
}

/* -------------------------------------------------------------------------- */
/*  Alerts                                                                    */
/* -------------------------------------------------------------------------- */

async function alert(text: string) {
  try {
    const settings = await getNctSettings()
    if (!settings.alertChannel) return
    const raw = settings.alertChannel.trim()
    const channelId = raw.startsWith('C')
      ? raw
      : await resolveChannelIdByName(raw)
    if (!channelId) return
    await postChannelMessage(channelId, text)
  } catch (err) {
    console.error('[nct-billing] alert failed:', err)
  }
}

const usd = (c: number) => `$${(c / 100).toFixed(2)}`

/**
 * One Slack post per lead, whatever the outcome — the alerts channel is
 * how the team watches this pipeline work in real time, so a silent
 * success is nearly as bad as a silent failure.
 *
 * Problems (failed / capped / unbillable) always post. Clean charges post
 * unless someone turns notifyEveryLead off.
 *
 * Never throws: a Slack outage must not roll back a charge that already
 * went through.
 */
async function notifyLead(
  lead: ParsedLead,
  status: string,
  opts: {
    config?: { clientName: string; weeklyCapCents: number; id: string }
    amountCents?: number
    reason?: string
  } = {},
) {
  try {
    const settings = await getNctSettings()
    const isProblem = status !== 'charged'
    if (!isProblem && !settings.notifyEveryLead) return

    const header =
      status === 'charged'
        ? '🧰 *New roofing lead — charged*'
        : status === 'failed'
          ? '⚠️ *New roofing lead — CHARGE FAILED*'
          : status === 'capped'
            ? '🛑 *New roofing lead — held at weekly cap*'
            : status === 'filtered'
              ? '📥 *Lead ignored — not a roofing lead*'
              : '📥 *New roofing lead — recorded, not charged*'

    const lines = [header]

    const who = [lead.name, lead.leadId].filter(Boolean).join(' · ')
    if (who) lines.push(who)

    const contact = [lead.phone, lead.email].filter(Boolean).join(' · ')
    if (contact) lines.push(contact)
    if (lead.address) lines.push(lead.address)

    if (opts.config) {
      lines.push(
        status === 'charged'
          ? `${opts.config.clientName} — ${usd(opts.amountCents ?? 0)} charged`
          : opts.config.clientName,
      )
    }

    // Cap progress, so nobody has to open the Hub to know how close we are.
    if (opts.config && opts.config.weeklyCapCents > 0) {
      const spent = await weeklyChargedCents(opts.config.id)
      const left = opts.config.weeklyCapCents - spent
      lines.push(
        `Week: ${usd(spent)} / ${usd(opts.config.weeklyCapCents)} cap` +
          (left > 0 ? ` · ${usd(left)} left` : ' · cap reached'),
      )
    }

    if (opts.reason) lines.push(`_${opts.reason}_`)
    if (status === 'failed') lines.push('Manual follow-up needed.')

    await alert(lines.join('\n'))
  } catch (err) {
    console.error('[nct-billing] lead notification failed:', err)
  }
}

/* -------------------------------------------------------------------------- */
/*  Charging                                                                  */
/* -------------------------------------------------------------------------- */

/** Resolve the card we should charge off-session for a Stripe customer. */
async function defaultPaymentMethod(customerId: string): Promise<string | null> {
  const cust = await stripeCall(`/customers/${customerId}`, 'GET')
  if (cust.ok) {
    const settings = cust.data.invoice_settings as
      | { default_payment_method?: string | { id?: string } }
      | undefined
    const dpm = settings?.default_payment_method
    if (typeof dpm === 'string' && dpm) return dpm
    if (dpm && typeof dpm === 'object' && dpm.id) return dpm.id
  }
  const pms = await stripeCall(
    `/payment_methods?customer=${customerId}&type=card&limit=1`,
    'GET',
  )
  const list = (pms.data.data as Array<{ id?: string }> | undefined) ?? []
  return list[0]?.id ?? null
}

type ChargeOutcome = {
  status: 'charged' | 'failed'
  paymentIntentId?: string
  chargeId?: string
  reason?: string
}

/**
 * Off-session charge for one lead. Idempotency-keyed on the NCT lead ID,
 * so a webhook replay can never bill the client twice even if our own
 * duplicate check somehow misses.
 */
async function chargeCard(
  customerId: string,
  amountCents: number,
  description: string,
  idempotencyKey: string,
): Promise<ChargeOutcome> {
  const pm = await defaultPaymentMethod(customerId)
  if (!pm) {
    return {
      status: 'failed',
      reason: 'No saved card on this Stripe customer.',
    }
  }

  const res = await stripeCall(
    '/payment_intents',
    'POST',
    {
      amount: amountCents,
      currency: 'usd',
      customer: customerId,
      payment_method: pm,
      off_session: true,
      confirm: true,
      description,
    },
    idempotencyKey,
  )

  if (!res.ok) {
    return { status: 'failed', reason: stripeMessage(res.data, 'Charge failed.') }
  }
  const status = String(res.data.status ?? '')
  if (status !== 'succeeded') {
    return {
      status: 'failed',
      reason: `Stripe returned status "${status}" (card may need authentication).`,
      paymentIntentId: String(res.data.id ?? ''),
    }
  }
  return {
    status: 'charged',
    paymentIntentId: String(res.data.id ?? ''),
    chargeId: String(res.data.latest_charge ?? '') || undefined,
  }
}

/* -------------------------------------------------------------------------- */
/*  Ingest                                                                    */
/* -------------------------------------------------------------------------- */

export type IngestResult = {
  ok: boolean
  duplicate?: boolean
  leadId: string | null
  status: string
  reason?: string
}

/**
 * The whole per-lead pipeline: dedupe → resolve client → filter →
 * cap check → charge → record. Always records a row, whatever happens,
 * so nothing NCT sends can vanish silently.
 */
export async function ingestLead(body: unknown): Promise<IngestResult> {
  const parsed = parseLeadPayload(body)
  const settings = await getNctSettings()

  if (!parsed.leadId) {
    return {
      ok: false,
      leadId: null,
      status: 'rejected',
      reason: 'Payload has no lead ID — refusing to record an unbillable lead.',
    }
  }

  // Idempotency: NCT's own ID is the key. A replay is a no-op.
  const existing = await prisma.nctLead.findUnique({
    where: { leadId: parsed.leadId },
  })
  if (existing) {
    return {
      ok: true,
      duplicate: true,
      leadId: parsed.leadId,
      status: existing.chargeStatus,
    }
  }

  // Which client is this lead for? A single active config is unambiguous.
  const configs = await prisma.nctBillingConfig.findMany({
    where: { active: true },
  })
  const config = parsed.sourceKey
    ? configs.find(
        (c) => c.sourceKey.toLowerCase() === parsed.sourceKey!.toLowerCase(),
      )
    : configs.length === 1
      ? configs[0]
      : undefined

  const base = {
    leadId: parsed.leadId,
    name: parsed.name,
    phone: parsed.phone,
    email: parsed.email,
    address: parsed.address,
    service: parsed.service,
    rawPayload: (body ?? {}) as object,
  }

  /**
   * Single exit point: persist the lead, then tell Slack. Every outcome
   * goes through here so the channel can't miss one and can't get two
   * posts for the same lead.
   */
  const record = async (
    status: string,
    extra: Record<string, unknown> = {},
  ): Promise<IngestResult> => {
    await prisma.nctLead.create({
      data: {
        ...base,
        configId: config?.id ?? null,
        clientName: config?.clientName ?? null,
        chargeStatus: status,
        ...extra,
      },
    })
    await notifyLead(parsed, status, {
      config,
      amountCents: (extra.amountCents as number) ?? undefined,
      reason: (extra.failureReason as string) ?? undefined,
    })
    return {
      ok: true,
      leadId: parsed.leadId,
      status,
      reason: (extra.failureReason as string) ?? undefined,
    }
  }

  if (!config) {
    const reason = parsed.sourceKey
      ? `No active client config matches sourceKey "${parsed.sourceKey}".`
      : 'No active client config to bill (add one, or have NCT send sourceKey).'
    return record('no_config', { failureReason: reason })
  }

  // Guard against misrouted verticals, exactly like the SOP's filter step.
  if (parsed.service && !/roof/i.test(parsed.service)) {
    return record('filtered', {
      failureReason: `Service "${parsed.service}" is not roofing.`,
    })
  }

  if (!settings.chargingEnabled) {
    return record('no_config', {
      failureReason: 'Charging is switched off in the NCT Leads tab.',
    })
  }

  // Weekly soft cap — the SOP's known gap, enforced here for real.
  if (config.weeklyCapCents > 0) {
    const spent = await weeklyChargedCents(config.id)
    if (spent + config.pricePerLeadCents > config.weeklyCapCents) {
      const reason = `Weekly cap reached for ${config.clientName} (${usd(config.weeklyCapCents)}). Lead held, not charged.`
      return record('capped', { failureReason: reason })
    }
  }

  const outcome = await chargeCard(
    config.stripeCustomerId,
    config.pricePerLeadCents,
    `NCT roofing lead ${parsed.leadId}${parsed.name ? ` — ${parsed.name}` : ''}`,
    `nct-lead-${parsed.leadId}`,
  )

  if (outcome.status === 'failed') {
    return record('failed', {
      amountCents: config.pricePerLeadCents,
      failureReason: outcome.reason,
      stripePaymentIntentId: outcome.paymentIntentId ?? null,
    })
  }

  return record('charged', {
    amountCents: config.pricePerLeadCents,
    chargedAt: new Date(),
    stripePaymentIntentId: outcome.paymentIntentId ?? null,
    stripeChargeId: outcome.chargeId ?? null,
  })
}

/** Re-attempt a lead that failed or was held by the cap. */
export async function retryLeadCharge(id: string): Promise<IngestResult> {
  const lead = await prisma.nctLead.findUnique({
    where: { id },
    include: { config: true },
  })
  if (!lead) return { ok: false, leadId: null, status: 'missing' }
  if (lead.chargeStatus === 'charged') {
    return { ok: true, leadId: lead.leadId, status: 'charged' }
  }
  if (!lead.config) {
    return {
      ok: false,
      leadId: lead.leadId,
      status: lead.chargeStatus,
      reason: 'This lead has no client config attached.',
    }
  }

  const outcome = await chargeCard(
    lead.config.stripeCustomerId,
    lead.config.pricePerLeadCents,
    `NCT roofing lead ${lead.leadId}${lead.name ? ` — ${lead.name}` : ''} (retry)`,
    // Fresh key: the original attempt failed, so we genuinely want a new charge.
    `nct-lead-${lead.leadId}-retry-${Date.now()}`,
  )

  await prisma.nctLead.update({
    where: { id },
    data:
      outcome.status === 'charged'
        ? {
            chargeStatus: 'charged',
            amountCents: lead.config.pricePerLeadCents,
            chargedAt: new Date(),
            stripePaymentIntentId: outcome.paymentIntentId ?? null,
            stripeChargeId: outcome.chargeId ?? null,
            failureReason: null,
          }
        : { chargeStatus: 'failed', failureReason: outcome.reason },
  })

  return {
    ok: outcome.status === 'charged',
    leadId: lead.leadId,
    status: outcome.status,
    reason: outcome.reason,
  }
}

/* -------------------------------------------------------------------------- */
/*  Sweep: Stripe available balance -> Mercury                                */
/* -------------------------------------------------------------------------- */

export type SweepResult = {
  status: 'ok' | 'failed' | 'skipped'
  amountCents: number
  detail?: string
  payoutId?: string
}

/**
 * Move settled Stripe cash to Mercury. Only ever touches the *available*
 * balance — pending funds physically cannot be paid out — minus the
 * configured floor.
 */
export async function runSweep(manual = false): Promise<SweepResult> {
  const settings = await getNctSettings()

  if (!settings.sweepEnabled && !manual) {
    return { status: 'skipped', amountCents: 0, detail: 'Sweep is disabled.' }
  }

  const balance = await stripeCall('/balance', 'GET')
  if (!balance.ok) {
    const detail = stripeMessage(balance.data, 'Could not read Stripe balance.')
    await prisma.nctSweep.create({
      data: { amountCents: 0, method: settings.sweepMethod, status: 'failed', detail, manual },
    })
    return { status: 'failed', amountCents: 0, detail }
  }

  const available =
    (balance.data.available as Array<{ amount: number; currency: string }>) ?? []
  const usdBalance = available.find((b) => b.currency === 'usd') ?? available[0]
  const availableCents = usdBalance?.amount ?? 0
  const amount = availableCents - settings.sweepFloorCents

  if (amount < settings.sweepMinCents || amount <= 0) {
    const detail = `Available ${(availableCents / 100).toFixed(2)} minus floor ${(settings.sweepFloorCents / 100).toFixed(2)} is under the ${(settings.sweepMinCents / 100).toFixed(2)} minimum.`
    if (manual) {
      await prisma.nctSweep.create({
        data: { amountCents: 0, method: settings.sweepMethod, status: 'skipped', detail, manual },
      })
    }
    return { status: 'skipped', amountCents: 0, detail }
  }

  const payout = await stripeCall('/payouts', 'POST', {
    amount,
    currency: usdBalance?.currency ?? 'usd',
    method: settings.sweepMethod,
    destination: settings.sweepDestinationId || undefined,
    description: 'Genisys → Mercury buffer top-up',
  })

  if (!payout.ok) {
    const detail = stripeMessage(payout.data, 'Payout failed.')
    await prisma.nctSweep.create({
      data: { amountCents: amount, method: settings.sweepMethod, status: 'failed', detail, manual },
    })
    await alert(`⚠️ *Stripe → Mercury sweep failed* — ${usd(amount)}
_${detail}_`)
    return { status: 'failed', amountCents: amount, detail }
  }

  const payoutId = String(payout.data.id ?? '')
  await prisma.nctSweep.create({
    data: {
      amountCents: amount,
      method: settings.sweepMethod,
      status: 'ok',
      stripePayoutId: payoutId,
      manual,
    },
  })
  await prisma.nctBillingSettings.update({
    where: { id: 'singleton' },
    data: { lastSweepAt: new Date() },
  })

  return { status: 'ok', amountCents: amount, payoutId }
}

/**
 * Stripe payout destinations (the Mercury card / checking link), so the
 * UI can offer a real dropdown instead of asking for a raw `card_…` id.
 */
export async function listPayoutDestinations(): Promise<
  Array<{ id: string; kind: string; label: string }>
> {
  try {
    const acct = await stripeCall('/account', 'GET')
    const acctId = String(acct.data.id ?? '')
    if (!acct.ok || !acctId) return []

    const res = await stripeCall(
      `/accounts/${acctId}/external_accounts?limit=20`,
      'GET',
    )
    if (!res.ok) return []

    return ((res.data.data as Array<Record<string, unknown>>) ?? []).map((e) => {
      const isCard = e.object === 'card'
      return {
        id: String(e.id),
        kind: isCard ? 'card' : 'bank_account',
        label: isCard
          ? `${e.brand ?? 'Card'} ••${e.last4 ?? ''} — instant`
          : `${e.bank_name ?? 'Bank'} ••${e.last4 ?? ''} — standard ACH`,
      }
    })
  } catch {
    // Not fatal — the UI falls back to a free-text destination field.
    return []
  }
}
