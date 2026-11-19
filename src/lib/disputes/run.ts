/**
 * Ingest a Stripe dispute, build the packet, and stage or submit it
 * according to the config. Dry-run never calls the dispute update endpoint.
 * Secrets are redacted before they reach a log or an audit row.
 */
import { prisma } from '@/lib/prisma'
import { hubAlert, hubLink } from '@/lib/hub-alerts'
import { claimStripeEvent, rememberedMemberByEmail } from '@/lib/stripe-onboarding'
import { textTeam } from '@/lib/team-sms'
import { loadDisputeConfig, loadTemplates } from './config'
import { gatherFacts, screenshotFor } from './gather'
import { pdfBytes, renderEvidencePdf } from './pdf'
import {
  budgetFiles,
  buildEvidence,
  chainHash,
  classifyStripeSideEffect,
  cleanEmail,
  decideAction,
  decideEfwRefund,
  decideManualSubmit,
  evidenceFormBody,
  matchDispute,
  phoneKey,
  publicConfig,
  readDispute,
  redactSecrets,
  sha256,
  templateFor,
  verifyChain,
  type DisputeIdentity,
  type MatchCandidate,
  type ParsedDispute,
  type SideEffect,
} from './plan'
import { recordStripeNotice } from './receipts'
import { listCustomerCharges, listDisputes, probeDisputeKey, refundCharge, retrieveDispute, stampMetadata, updateDisputeEvidence, uploadDisputeFile, type ProbeResult } from './stripe'

const OPEN = new Set(['needs_response', 'warning_needs_response'])

function json(v: unknown) {
  return JSON.parse(JSON.stringify(v ?? null))
}

async function audit(disputeId: string, kind: string, detail: string | null, payload: unknown, actor: string): Promise<void> {
  const bodyBase = { kind, detail, actor, payload: payload ?? null }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await prisma.$transaction(async (tx) => {
        const last = await tx.stripeDisputeEvent.findFirst({ where: { disputeId }, orderBy: { seq: 'desc' } })
        const prev = last?.contentHash ?? 'genesis'
        const seq = (last?.seq ?? 0) + 1
        const createdAt = new Date()
        const body = { ...bodyBase, seq, createdAt: createdAt.toISOString() }
        await tx.stripeDisputeEvent.create({
          data: { disputeId, seq, kind, detail, actor, payload: json(payload), prevHash: prev, contentHash: chainHash(prev, body), createdAt },
        })
      })
      return
    } catch (err) {
      const unique = !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002'
      if (unique && attempt < 2) continue
      throw err
    }
  }
}

async function candidates(): Promise<MatchCandidate[]> {
  const clients = await prisma.client.findMany({
    select: {
      id: true,
      name: true,
      contactName: true,
      contactEmail: true,
      contactPhone: true,
      disputeCount: true,
      intakes: { select: { id: true, leadEmail: true, customerPhone: true, businessName: true, fullName: true, businessContact: true } },
      users: { select: { email: true } },
    },
  })
  return clients.map((c) => ({
    clientId: c.id,
    name: c.name,
    emails: [c.contactEmail, ...c.intakes.map((i) => i.leadEmail), ...c.users.map((u) => u.email)],
    phones: [c.contactPhone, ...c.intakes.map((i) => i.customerPhone), ...c.intakes.map((i) => i.businessContact)],
    people: [c.contactName, ...c.intakes.map((i) => i.fullName)],
    businessNames: [c.name, ...c.intakes.map((i) => i.businessName)],
    intakeIds: c.intakes.map((i) => i.id),
    disputeCount: c.disputeCount,
  }))
}

async function refreshCounts(clientIds: (string | null)[]): Promise<void> {
  for (const id of [...new Set(clientIds.filter((x): x is string => !!x))]) {
    const count = await prisma.stripeDispute.count({ where: { clientId: id } })
    const last = await prisma.stripeDispute.findFirst({ where: { clientId: id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } })
    await prisma.client.update({ where: { id }, data: { disputeCount: count, lastDisputeAt: last?.createdAt ?? null } })
  }
}

async function rememberAlert(disputeId: string, kind: string): Promise<boolean> {
  const prior = await prisma.stripeDisputeEvent.findFirst({ where: { disputeId, kind: 'alerted', detail: kind } })
  if (prior) return false
  await audit(disputeId, 'alerted', kind, null, 'system')
  return true
}

function money(cents: number, currency: string): string {
  const prefix = currency.toLowerCase() === 'usd' ? '$' : `${currency.toUpperCase()} `
  return prefix + (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2))
}

async function alertNew(row: { id: string; amountCents: number; currency: string; reason: string; dueBy: Date | null; livemode: boolean; clientId: string | null }, matchNote: string): Promise<void> {
  if (!(await rememberAlert(row.id, 'opened'))) return
  const client = row.clientId ? await prisma.client.findUnique({ where: { id: row.clientId }, select: { name: true, disputeCount: true } }) : null
  const repeat = client && client.disputeCount >= 2 ? ` Repeat disputer (${client.disputeCount} disputes).` : client?.disputeCount === 1 ? ' This client has disputed before.' : ''
  const due = row.dueBy ? row.dueBy.toISOString().slice(0, 10) : 'no deadline yet'
  const text = `:rotating_light: *Stripe dispute* — ${money(row.amountCents, row.currency)} · ${row.reason} · ${client?.name ?? 'unmatched'}.${repeat} Due ${due}. ${matchNote} The packet is being compiled. Defense is still in dry-run unless you changed it. <${hubLink('/payments?tab=disputes')}|Disputes>`
  await hubAlert(text).catch(() => {})
  const config = await loadDisputeConfig()
  if (config.alertSms && row.livemode && process.env.NODE_ENV === 'production') {
    await textTeam(`Genisys: Stripe dispute ${money(row.amountCents, row.currency)} (${row.reason}) for ${client?.name ?? 'an unmatched customer'}.${repeat} ${hubLink('/payments?tab=disputes')}`, 'Stripe dispute').catch(() => {})
  }
}

export async function upsertDispute(parsed: ParsedDispute, actor: string): Promise<string> {
  const existing = await prisma.stripeDispute.findUnique({ where: { stripeDisputeId: parsed.stripeDisputeId } })
  const pool = await candidates()
  const identity: DisputeIdentity = { email: parsed.email, phone: parsed.phone, name: parsed.name, metadata: parsed.metadata }
  const matched = existing?.matchMethod === 'manual' && existing.clientId
    ? { clientId: existing.clientId, intakeId: existing.intakeId, method: 'manual' as const, confidence: 'exact' as const, disputeCount: 0, repeatDisputer: false }
    : matchDispute(identity, pool)
  const data = {
    stripeChargeId: parsed.stripeChargeId,
    stripePaymentIntentId: parsed.stripePaymentIntentId,
    stripeCustomerId: parsed.stripeCustomerId,
    stripeInvoiceId: parsed.stripeInvoiceId,
    status: parsed.status,
    reason: parsed.reason,
    networkReasonCode: parsed.networkReasonCode,
    amountCents: parsed.amountCents,
    currency: parsed.currency,
    dueBy: parsed.dueBy ? new Date(parsed.dueBy) : null,
    chargedAt: parsed.chargedAt ? new Date(parsed.chargedAt) : null,
    livemode: parsed.livemode,
    cardBrand: parsed.cardBrand,
    stripeSubmitted: parsed.stripeSubmitted,
    clientId: matched.clientId,
    intakeId: matched.intakeId,
    matchMethod: matched.method,
    matchConfidence: matched.confidence,
    raw: json(parsed),
  }
  const row = existing
    ? await prisma.stripeDispute.update({ where: { id: existing.id }, data })
    : await prisma.stripeDispute.create({ data: { ...data, stripeDisputeId: parsed.stripeDisputeId } })
  await refreshCounts([existing?.clientId ?? null, row.clientId])
  await audit(row.id, existing ? 'reconciled' : 'ingested', `${parsed.status} · ${parsed.reason} · match ${matched.method}/${matched.confidence}`, { stripeDisputeId: parsed.stripeDisputeId }, actor)
  if (!existing) await alertNew(row, `Matched by ${matched.method} (${matched.confidence}).`)
  if (matched.clientId && matched.confidence !== 'none' && matched.confidence !== 'weak') {
    await stampHub({ customerId: parsed.stripeCustomerId, chargeId: parsed.stripeChargeId, paymentIntentId: parsed.stripePaymentIntentId, clientId: matched.clientId, intakeId: matched.intakeId }).catch(() => {})
  }
  if (OPEN.has(parsed.status) && !parsed.stripeSubmitted && !row.submittedAt) await advance(row.id, actor).catch((err) => noteError(row.id, err))
  return row.id
}

async function noteError(id: string, err: unknown): Promise<void> {
  const message = redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 400)
  await prisma.stripeDispute.update({ where: { id }, data: { lastError: message } }).catch(() => {})
  await audit(id, 'error', message, null, 'system').catch(() => {})
}

async function stampHub(o: { customerId: string | null; chargeId: string | null; paymentIntentId: string | null; clientId: string | null; intakeId: string | null }): Promise<void> {
  const config = await loadDisputeConfig()
  if (!config.stampMetadata || !o.clientId) return
  const metadata: Record<string, string> = { hub_client_id: o.clientId }
  if (o.intakeId) metadata.hub_intake_id = o.intakeId
  const jobs: Promise<void>[] = []
  if (o.customerId) jobs.push(stampMetadata('customers', o.customerId, metadata))
  if (o.chargeId) jobs.push(stampMetadata('charges', o.chargeId, metadata))
  if (o.paymentIntentId) jobs.push(stampMetadata('payment_intents', o.paymentIntentId, metadata))
  await Promise.all(jobs)
}

/** Build the packet and, unless dry-run, stage or submit it. */
export async function advance(id: string, actor: string, opts: { forceRebuild?: boolean; forceSubmit?: boolean } = {}): Promise<void> {
  const row = await prisma.stripeDispute.findUnique({ where: { id } })
  if (!row) return
  const config = await loadDisputeConfig()
  if (opts.forceSubmit) {
    const gate = decideManualSubmit(config)
    if (!gate.ok) throw new Error(gate.reason)
  }
  const templates = await loadTemplates()
  let priors: unknown[] = []
  let email = null as string | null
  let name = null as string | null
  let phone = null as string | null
  let billing = null as string | null
  let cardBrand = row.cardBrand
  let chargedAt = row.chargedAt
  let chargeRefunded = row.status === 'charge_refunded'
  if (row.stripeCustomerId) {
    try {
      const charges = await listCustomerCharges(row.stripeCustomerId)
      priors = charges.filter((c) => c.id !== row.stripeChargeId)
      const own = charges.find((c) => c.id === row.stripeChargeId)
      if (own) {
        const parsed = readDispute({ id: row.stripeDisputeId, object: 'dispute', reason: row.reason, status: row.status, amount: row.amountCents, currency: row.currency, livemode: row.livemode }, own)
        if (parsed) {
          email = parsed.email
          name = parsed.name
          phone = parsed.phone
          billing = parsed.billingAddress
          cardBrand = parsed.cardBrand ?? cardBrand
          chargedAt = parsed.chargedAt ? new Date(parsed.chargedAt) : chargedAt
          chargeRefunded = parsed.chargeRefunded
        }
      }
    } catch (err) {
      await noteError(id, err)
    }
  }
  const facts = await gatherFacts({
    disputeId: row.stripeDisputeId,
    clientId: row.clientId,
    intakeId: row.intakeId,
    reason: row.reason,
    status: row.status,
    amountCents: row.amountCents,
    currency: row.currency,
    dueBy: row.dueBy,
    chargedAt,
    cardBrand,
    email,
    name,
    phone,
    billingAddress: billing,
    chargeRefunded,
    narrative: row.narrative,
    template: templateFor(row.reason, templates),
    priorCharges: priors,
  })
  const built = buildEvidence(facts)
  const pdf = renderEvidencePdf(built.sections)
  const shot = row.clientId ? await screenshotFor(row.clientId).catch(() => null) : null
  const budget = budgetFiles(pdf.length, shot ? [{ bytes: shot.bytes.length }] : [])
  const packetSha = sha256(pdf)
  const evidenceSha = sha256(JSON.stringify({ fields: built.fields, ce3: built.ce3, ledger: built.ledgerHashes, packetSha }))
  await prisma.stripeDispute.update({
    where: { id },
    data: {
      evidenceJson: json(built.fields),
      compellingEvidence: built.ce3 ? json(built.ce3) : undefined,
      evidenceSha256: evidenceSha,
      packetPdf: pdfBytes(pdf),
      packetBytes: pdf.length,
      packetSha256: packetSha,
      packetBuiltAt: new Date(),
      cardBrand: cardBrand ?? undefined,
      chargedAt: chargedAt ?? undefined,
      defenseStatus: row.defenseStatus === 'submitted' ? 'submitted' : 'compiled',
      lastError: null,
    },
  })
  await audit(id, 'compiled', built.summary, { packetSha256: packetSha, evidenceSha256: evidenceSha, ledgerHashes: built.ledgerHashes, fileNotes: budget.notes }, actor)

  const decision = opts.forceSubmit
    ? { action: 'submit' as const, stripeSubmit: true, reason: 'an admin submitted it' }
    : decideAction({
        config,
        status: row.status,
        dueBy: row.dueBy?.toISOString() ?? null,
        now: new Date().toISOString(),
        paused: row.paused,
        narrativeEdited: !!row.narrativeEditedAt,
        alreadySubmitted: row.stripeSubmitted || !!row.submittedAt,
        matchConfidence: (row.matchConfidence as 'exact' | 'strong' | 'weak' | 'none') ?? 'none',
      })
  const unchanged = !opts.forceRebuild && !opts.forceSubmit && row.evidenceSha256 === evidenceSha && row.packetSha256 === packetSha
  if (decision.action === 'skip' || decision.action === 'compile_only') {
    if (!unchanged) await audit(id, decision.action === 'compile_only' ? 'dry_run' : 'compiled', decision.reason, null, actor)
    return
  }
  if (unchanged && decision.action === 'stage' && row.stripeFileId) return
  const files: Record<string, string> = {}
  const pdfId = await uploadDisputeFile(pdf, `dispute-${row.stripeDisputeId}.pdf`, 'application/pdf')
  files.uncategorized_file = pdfId
  if (shot && budget.keep[0]) {
    files.service_documentation = await uploadDisputeFile(shot.bytes, `setup-${row.stripeDisputeId}.${shot.mime === 'image/png' ? 'png' : 'jpg'}`, shot.mime)
  }
  const form = evidenceFormBody({ fields: built.fields, files, ce3: built.ce3, submit: decision.stripeSubmit })
  await updateDisputeEvidence(row.stripeDisputeId, form)
  await prisma.stripeDispute.update({
    where: { id },
    data: {
      stripeFileId: pdfId,
      defenseStatus: decision.stripeSubmit ? 'submitted' : 'staged',
      stagedAt: new Date(),
      submittedAt: decision.stripeSubmit ? new Date() : row.submittedAt,
      stripeSubmitted: decision.stripeSubmit ? true : row.stripeSubmitted,
      lastError: null,
    },
  })
  await audit(id, decision.stripeSubmit ? 'submitted' : 'staged', decision.reason, { file: pdfId }, actor)
  if (decision.stripeSubmit && (await rememberAlert(id, 'submitted'))) {
    await hubAlert(`:white_check_mark: *Dispute evidence submitted* — ${row.stripeDisputeId}. This is final. <${hubLink('/payments?tab=disputes')}|Disputes>`).catch(() => {})
  }
}

export async function handleStripeSideEffect(effect: SideEffect): Promise<void> {
  if (effect.eventId && !(await claimStripeEvent(effect.eventId))) return
  if (effect.kind === 'dispute') {
    await upsertDispute(effect.dispute, 'stripe-webhook')
    return
  }
  if (effect.kind === 'early_fraud_warning') {
    await handleEfw(effect)
    return
  }
  if (effect.kind === 'invoice_paid') await handleInvoicePaid(effect)
}

async function handleEfw(effect: Extract<SideEffect, { kind: 'early_fraud_warning' }>): Promise<void> {
  const config = await loadDisputeConfig()
  const decision = decideEfwRefund({ config, actionable: effect.actionable, livemode: effect.livemode })
  let action = 'none'
  let detail = decision.reason
  if (decision.refund && effect.chargeId) {
    try {
      await refundCharge(effect.chargeId)
      action = 'refunded'
      detail = 'Refunded to avoid a dispute.'
    } catch (err) {
      action = 'skipped'
      detail = redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300)
    }
  } else if (config.efwRefund && config.mode !== 'live') {
    action = 'dry_run'
  }
  await prisma.earlyFraudWarning.upsert({
    where: { stripeWarningId: effect.warningId },
    create: {
      stripeWarningId: effect.warningId,
      stripeChargeId: effect.chargeId,
      actionable: effect.actionable,
      fraudType: effect.fraudType,
      livemode: effect.livemode,
      action,
      actionDetail: detail,
      raw: json(effect.raw),
    },
    update: { action, actionDetail: detail, actionable: effect.actionable, fraudType: effect.fraudType },
  })
  await hubAlert(`:warning: *Early fraud warning* — charge ${effect.chargeId ?? 'unknown'}${effect.fraudType ? ` (${effect.fraudType})` : ''}. ${detail} <${hubLink('/payments?tab=disputes')}|Disputes>`).catch(() => {})
}

async function handleInvoicePaid(effect: Extract<SideEffect, { kind: 'invoice_paid' }>): Promise<void> {
  const email = cleanEmail(effect.email)
  let clientId: string | null = null
  let intakeId: string | null = null
  if (email) {
    const pool = await candidates()
    const match = matchDispute({ email, phone: null, name: effect.name, metadata: {} }, pool)
    clientId = match.clientId
    intakeId = match.intakeId
  }
  if (!clientId && effect.customerId) {
    const remembered = await rememberedMemberByEmail(email ?? '').catch(() => null)
    if (remembered?.email && email && remembered.email === email) {
      /* customer id is on the event; matching already used the email */
    }
  }
  await recordStripeNotice({
    clientId,
    email,
    amountCents: effect.amountCents,
    currency: effect.currency,
    chargeId: effect.chargeId,
    invoiceId: effect.invoiceId,
  }).catch(() => {})
  if (clientId) {
    await stampHub({ customerId: effect.customerId, chargeId: effect.chargeId, paymentIntentId: effect.paymentIntentId, clientId, intakeId }).catch(() => {})
  }
}

export async function reconcileDisputes(): Promise<{ seen: number }> {
  const statuses = ['needs_response', 'warning_needs_response', 'under_review', 'warning_under_review']
  let seen = 0
  for (const status of statuses) {
    let page: Awaited<ReturnType<typeof listDisputes>> = []
    try {
      page = await listDisputes(status)
    } catch (err) {
      console.error(`[disputes] list ${status}:`, redactSecrets(err instanceof Error ? err.message : String(err)))
      continue
    }
    for (const item of page) {
      try {
        const full = await retrieveDispute(String(item.id))
        const parsed = readDispute(full)
        if (!parsed) continue
        await upsertDispute(parsed, 'reconcile')
        seen++
      } catch (err) {
        console.error('[disputes] reconcile one:', redactSecrets(err instanceof Error ? err.message : String(err)))
      }
    }
  }
  return { seen }
}

export async function maybeReconcileDisputes(): Promise<void> {
  if (process.env.NODE_ENV !== 'production' && process.env.DISPUTE_DEFENSE_CRON !== '1') return
  await reconcileDisputes()
}

export async function pauseDispute(id: string, actor: string, paused: boolean): Promise<void> {
  await prisma.stripeDispute.update({
    where: { id },
    data: { paused, pausedAt: paused ? new Date() : null, pausedBy: paused ? actor : null, defenseStatus: paused ? 'held' : undefined },
  })
  await audit(id, paused ? 'paused' : 'resumed', null, null, actor)
}

export async function saveNarrative(id: string, actor: string, narrative: string): Promise<void> {
  await prisma.stripeDispute.update({ where: { id }, data: { narrative, narrativeEditedAt: new Date(), narrativeEditedBy: actor } })
  await audit(id, 'edited', 'Narrative edited. Auto-submit is off until someone submits it.', null, actor)
  await advance(id, actor, { forceRebuild: true })
}

export async function assignDispute(id: string, actor: string, clientId: string): Promise<void> {
  const prev = await prisma.stripeDispute.findUnique({ where: { id }, select: { clientId: true } })
  const intake = await prisma.clientIntake.findFirst({ where: { clientId }, orderBy: { receivedAt: 'desc' }, select: { id: true } })
  await prisma.stripeDispute.update({ where: { id }, data: { clientId, intakeId: intake?.id ?? null, matchMethod: 'manual', matchConfidence: 'exact' } })
  await refreshCounts([prev?.clientId ?? null, clientId])
  await audit(id, 'assigned', `Linked to client ${clientId}`, null, actor)
  await advance(id, actor, { forceRebuild: true })
}

export async function disputeDetail(id: string) {
  const row = await prisma.stripeDispute.findUnique({
    where: { id },
    include: { events: { orderBy: { seq: 'asc' } }, client: { select: { id: true, name: true, disputeCount: true, contactEmail: true } } },
  })
  if (!row) return null
  const chain = verifyChain(row.events.map((e) => ({ prevHash: e.prevHash, contentHash: e.contentHash, body: { kind: e.kind, detail: e.detail, actor: e.actor, payload: e.payload, seq: e.seq, createdAt: e.createdAt.toISOString() } })))
  const packetIntact = row.packetPdf && row.packetSha256 ? sha256(Buffer.from(row.packetPdf)) === row.packetSha256 : null
  return {
    id: row.id,
    stripeDisputeId: row.stripeDisputeId,
    status: row.status,
    reason: row.reason,
    amountCents: row.amountCents,
    currency: row.currency,
    dueBy: row.dueBy?.toISOString() ?? null,
    livemode: row.livemode,
    defenseStatus: row.defenseStatus,
    paused: row.paused,
    matchMethod: row.matchMethod,
    matchConfidence: row.matchConfidence,
    client: row.client,
    narrative: row.narrative,
    narrativeEditedAt: row.narrativeEditedAt?.toISOString() ?? null,
    packetBytes: row.packetBytes,
    packetSha256: row.packetSha256,
    packetBuiltAt: row.packetBuiltAt?.toISOString() ?? null,
    packetIntact,
    evidenceSha256: row.evidenceSha256,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    lastError: row.lastError,
    chain,
    repeat: row.client ? row.client.disputeCount >= 2 : false,
    events: row.events.map((e) => ({ seq: e.seq, kind: e.kind, detail: e.detail, actor: e.actor, at: e.createdAt.toISOString(), contentHash: e.contentHash })),
  }
}

export async function listDisputeRows() {
  const [rows, config, templates] = await Promise.all([
    prisma.stripeDispute.findMany({
      orderBy: [{ dueBy: 'asc' }, { createdAt: 'desc' }],
      select: {
        id: true, stripeDisputeId: true, status: true, reason: true, amountCents: true, currency: true, dueBy: true, livemode: true,
        defenseStatus: true, paused: true, matchMethod: true, matchConfidence: true, packetBytes: true, packetSha256: true,
        packetBuiltAt: true, submittedAt: true, lastError: true, client: { select: { id: true, name: true, disputeCount: true } },
      },
    }),
    loadDisputeConfig(),
    loadTemplates(),
  ])
  return { rows, config: publicConfig(config), templates }
}

export async function runProbe(): Promise<ProbeResult> {
  const result = await probeDisputeKey()
  await prisma.appSetting.upsert({
    where: { key: 'disputes.probe' },
    create: { key: 'disputes.probe', value: JSON.stringify(result) },
    update: { value: JSON.stringify(result) },
  }).catch(() => {})
  return result
}

export { classifyStripeSideEffect, phoneKey }
