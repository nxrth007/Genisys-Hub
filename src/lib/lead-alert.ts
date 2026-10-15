/**
 * Lead texts for clients without an EIN.
 *
 * A client's sub-account can't send SMS until its A2P brand is registered,
 * and that needs an EIN. So every client sub-account carries one identical
 * workflow (Form Submitted / chat widget → Webhook) that posts the lead to
 * /api/webhooks/ghl-lead. The Hub finds the client by the payload's
 * location id and, when the client is marked No EIN, texts their
 * contactPhone from the Lead Genisys sub-account. Clients with an EIN are
 * logged and skipped — their own sub-account handles it.
 */
import { createHash } from 'crypto'
import { prisma } from '@/lib/prisma'
import { sendSmsToPhone } from '@/lib/ghl'
import { formatPhoneDisplay } from '@/lib/phone'
import { hubAlertThrottled, hubLink } from '@/lib/hub-alerts'
import type { Prisma } from '@/generated/prisma/client'

export const LEAD_WEBHOOK_SECRET_ENTRY = 'GHL Lead Webhook Secret'

const DEDUP_WINDOW_MS = 10 * 60_000
const STUCK_SENDING_MS = 5 * 60_000
const MESSAGE_MAX = 320

export type ParsedLead = {
  locationId: string | null
  locationName: string | null
  contactId: string | null
  name: string | null
  phone: string | null
  email: string | null
  message: string | null
  source: string | null
  /** customData entries other than `source` and `message`, in order. */
  extras: { label: string; value: string }[]
}

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function text(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t : null
}

// Top-level keys of GHL's standard webhook payload that are contact
// attributes, not answers the lead typed into the form.
const STANDARD_KEYS = new Set([
  'contact_id', 'first_name', 'last_name', 'full_name', 'name', 'email', 'phone', 'tags',
  'country', 'date_created', 'full_address', 'address1', 'city', 'state', 'postal_code',
  'company_name', 'website', 'timezone', 'contact_type', 'contact_source', 'location',
  'workflow', 'triggerData', 'contact', 'attributionSource', 'customData', 'custom_data',
  'user', 'date_of_birth', 'source',
])

const MESSAGE_KEY = /message|comment|note|project|describe|description|details|question|inquiry|how can we help|needs/i

function findMessage(body: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(body)) {
    if (STANDARD_KEYS.has(key) || !MESSAGE_KEY.test(key)) continue
    const t = text(value)
    if (t) return t
  }
  return null
}

function sourceFrom(body: Record<string, unknown>): string | null {
  const contact = rec(body.contact)
  const attribution =
    rec(contact?.attributionSource) ?? rec(body.attributionSource) ?? rec(contact?.lastAttributionSource)
  const medium = text(attribution?.medium)?.toLowerCase() ?? ''
  if (medium.includes('chat')) return 'Chat widget'
  if (medium.includes('survey')) return 'Survey'
  if (medium.includes('form')) return 'Website form'
  return text(body.contact_source)
}

/**
 * Reads GHL's standard workflow Webhook payload. Anything set under the
 * action's Custom Data wins: `source` and `message` override the guesses,
 * and other keys are passed through to the text as "Key: value".
 */
export function parseGhlLead(body: Record<string, unknown>): ParsedLead {
  const location = rec(body.location)
  const contact = rec(body.contact)
  const custom = rec(body.customData) ?? rec(body.custom_data)
  const first = text(body.first_name)
  const last = text(body.last_name)
  const extras: ParsedLead['extras'] = []
  for (const [key, value] of Object.entries(custom ?? {})) {
    if (key === 'source' || key === 'message' || key === 'location_id') continue
    const t = text(value)
    if (t) extras.push({ label: key, value: t })
  }
  return {
    locationId:
      text(location?.id) ?? text(body.location_id) ?? text(body.locationId) ?? text(custom?.location_id),
    locationName: text(location?.name),
    contactId: text(body.contact_id) ?? text(body.contactId) ?? text(contact?.id),
    name: text(body.full_name) ?? ([first, last].filter(Boolean).join(' ') || null) ?? text(body.name),
    phone: text(body.phone) ?? text(contact?.phone),
    email: text(body.email) ?? text(contact?.email),
    message: text(custom?.message) ?? findMessage(body),
    source: text(custom?.source) ?? sourceFrom(body),
    extras,
  }
}

function phoneKey(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = String(raw).replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length >= 10) return `+${digits}`
  return null
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s
}

export function formatLeadSms(clientName: string, lead: ParsedLead): string {
  const lines = [`New lead for ${clientName}`, '']
  lines.push(lead.name ?? 'No name given')
  if (lead.phone) {
    const us = phoneKey(lead.phone)?.match(/^\+1(\d{3})(\d{3})(\d{4})$/)
    lines.push(us ? `(${us[1]}) ${us[2]}-${us[3]}` : formatPhoneDisplay(lead.phone) || lead.phone)
  }
  if (lead.email) lines.push(lead.email)
  if (lead.message) lines.push(`"${clip(lead.message.replace(/\s+/g, ' '), MESSAGE_MAX)}"`)
  for (const e of lead.extras) lines.push(`${e.label}: ${clip(e.value, 120)}`)
  if (lead.source) lines.push(`Source: ${lead.source}`)
  lines.push('', 'Reply STOP to opt out.')
  return lines.join('\n')
}

type Decision =
  | { send: true; client: EligibleClient; recipientPhone: string }
  | { send: false; status: 'skipped' | 'unrouted' | 'failed'; reason: string; clientId: string | null }

type EligibleClient = { id: string; name: string; contactName: string | null }

async function decide(locationId: string): Promise<Decision & { senderPhone: string | null; vaultEntryName: string }> {
  const [client, config] = await Promise.all([
    prisma.client.findUnique({
      where: { ghlLocationId: locationId },
      select: { id: true, name: true, contactName: true, contactPhone: true, einStatus: true, active: true },
    }),
    prisma.clientAlertsConfig.upsert({ where: { id: 'singleton' }, create: {}, update: {} }),
  ])
  const base = { senderPhone: config.senderPhone, vaultEntryName: config.vaultEntryName }
  if (!client) {
    return { ...base, send: false, status: 'unrouted', reason: 'No client in the Hub is linked to this sub-account.', clientId: null }
  }
  if (client.einStatus !== 'none') {
    return { ...base, send: false, status: 'skipped', reason: 'Client isn’t marked No EIN — their own sub-account sends lead texts.', clientId: client.id }
  }
  if (!client.active) {
    return { ...base, send: false, status: 'skipped', reason: 'Client is inactive.', clientId: client.id }
  }
  if (!config.leadAlertsEnabled) {
    return { ...base, send: false, status: 'skipped', reason: 'Lead texts are turned off in Settings.', clientId: client.id }
  }
  const recipientPhone = phoneKey(client.contactPhone)
  if (!recipientPhone) {
    return { ...base, send: false, status: 'failed', reason: 'No contact phone on the client card.', clientId: client.id }
  }
  return { ...base, send: true, client, recipientPhone }
}

export type LeadAlertResult = {
  status: 'delivered' | 'failed' | 'skipped' | 'unrouted' | 'duplicate' | 'invalid'
  id?: string
  reason?: string
}

/** Handles one webhook post. Never throws for a bad lead — only for infra errors. */
export async function handleGhlLead(body: Record<string, unknown>): Promise<LeadAlertResult> {
  const lead = parseGhlLead(body)
  const locationId = lead.locationId
  if (!locationId) return { status: 'invalid', reason: 'The payload has no location id.' }
  const leadPhone = phoneKey(lead.phone)
  const contactKey =
    lead.contactId ??
    leadPhone ??
    lead.email?.toLowerCase() ??
    createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 16)
  const dedupKey = `${locationId}:${contactKey}:${Math.floor(Date.now() / DEDUP_WINDOW_MS)}`

  // The bucket alone misses a pair that straddles its boundary.
  const sameLead: Prisma.LeadAlertWhereInput[] = []
  if (lead.contactId) sameLead.push({ contactId: lead.contactId })
  if (leadPhone) sameLead.push({ leadPhone })
  if (sameLead.length > 0) {
    const recent = await prisma.leadAlert.findFirst({
      where: { locationId, createdAt: { gte: new Date(Date.now() - DEDUP_WINDOW_MS) }, OR: sameLead },
      select: { id: true },
    })
    if (recent) return { status: 'duplicate', id: recent.id }
  }

  const d = await decide(locationId)
  let row: { id: string }
  try {
    row = await prisma.leadAlert.create({
      data: {
        dedupKey,
        locationId,
        contactId: lead.contactId,
        clientId: d.send ? d.client.id : d.clientId,
        leadName: lead.name,
        leadPhone,
        leadEmail: lead.email,
        source: lead.source,
        recipientPhone: d.send ? d.recipientPhone : null,
        status: d.send ? 'sending' : d.status,
        reason: d.send ? null : d.reason,
        payload: body as Prisma.InputJsonValue,
      },
      select: { id: true },
    })
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return { status: 'duplicate' }
    throw err
  }

  if (!d.send) {
    if (d.status === 'unrouted') {
      await hubAlertThrottled(
        `lead-alert:unrouted:${locationId}`,
        6 * 60 * 60_000,
        `:warning: *A sub-account sent a lead the Hub can't place* — ${lead.locationName ? `*${lead.locationName}* ` : ''}(location \`${locationId}\`) isn't linked to any client, so nobody was texted. Link it on the client card, then hit Retry in <${hubLink('/settings/client-alerts')}|Client SMS → Lead texts>.`,
      )
    } else if (d.status === 'failed') {
      await alertFailure(row.id, d.reason)
    }
    return { status: d.status, id: row.id, reason: d.reason }
  }
  return send(row.id, d.client, d.recipientPhone, lead, d)
}

async function send(
  id: string,
  client: EligibleClient,
  recipientPhone: string,
  lead: ParsedLead,
  cfg: { senderPhone: string | null; vaultEntryName: string },
): Promise<LeadAlertResult> {
  const [firstName, ...rest] = (client.contactName ?? '').trim().split(/\s+/).filter(Boolean)
  try {
    const sent = await sendSmsToPhone(cfg.vaultEntryName, {
      phone: recipientPhone,
      message: formatLeadSms(client.name, lead),
      firstName,
      lastName: rest.length ? rest.join(' ') : undefined,
      companyName: client.name,
      ...(cfg.senderPhone ? { fromNumber: cfg.senderPhone } : {}),
    })
    await prisma.leadAlert.update({
      where: { id },
      data: { status: 'delivered', reason: null, errorMessage: null, messageId: sent.messageId ?? null, deliveredAt: new Date() },
    })
    return { status: 'delivered', id }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await prisma.leadAlert.update({
      where: { id },
      data: { status: 'failed', reason: 'GHL didn’t send the text.', errorMessage: message.slice(0, 2000) },
    })
    await alertFailure(id, message)
    return { status: 'failed', id, reason: message }
  }
}

async function alertFailure(id: string, reason: string): Promise<void> {
  const row = await prisma.leadAlert.findUnique({
    where: { id },
    select: { leadName: true, client: { select: { name: true } } },
  })
  await hubAlertThrottled(
    `lead-alert:failed:${row?.client?.name ?? id}`,
    30 * 60_000,
    `:rotating_light: *Lead text didn't go out* — ${row?.client?.name ?? 'a No EIN client'} wasn't told about ${row?.leadName ?? 'a new lead'}. ${reason} Retry from <${hubLink('/settings/client-alerts')}|Client SMS → Lead texts>.`,
  )
}

/**
 * Re-runs a logged lead: re-checks which client it belongs to and whether
 * they're No EIN, so a sub-account linked after the fact can be caught up.
 */
export async function retryLeadAlert(id: string): Promise<LeadAlertResult> {
  const row = await prisma.leadAlert.findUnique({ where: { id } })
  if (!row) return { status: 'failed', reason: 'Not found.' }
  if (row.status === 'delivered') return { status: 'delivered', id, reason: 'Already delivered.' }
  if (row.status === 'sending' && Date.now() - row.updatedAt.getTime() < STUCK_SENDING_MS) {
    return { status: 'duplicate', id, reason: 'Already sending.' }
  }
  const claimed = await prisma.leadAlert.updateMany({
    where: { id, status: row.status, updatedAt: row.updatedAt },
    data: { status: 'sending' },
  })
  if (claimed.count === 0) return { status: 'duplicate', id, reason: 'Someone else is retrying it.' }

  const d = await decide(row.locationId)
  if (!d.send) {
    await prisma.leadAlert.update({
      where: { id },
      data: { status: d.status, reason: d.reason, clientId: d.clientId, recipientPhone: null },
    })
    return { status: d.status, id, reason: d.reason }
  }
  await prisma.leadAlert.update({ where: { id }, data: { clientId: d.client.id, recipientPhone: d.recipientPhone } })
  const body = rec(row.payload) ?? {}
  return send(id, d.client, d.recipientPhone, parseGhlLead(body), d)
}

export type LeadAlertRow = {
  id: string
  status: string
  reason: string | null
  errorMessage: string | null
  clientId: string | null
  clientName: string | null
  locationId: string
  locationName: string | null
  leadName: string | null
  leadPhone: string | null
  source: string | null
  recipientPhone: string | null
  createdAt: string
  deliveredAt: string | null
}

export type NoEinClientRow = {
  id: string
  name: string
  contactPhone: string | null
  linked: boolean
  lastLeadAt: string | null
  lastStatus: string | null
}

export async function leadAlertsOverview(limit = 30): Promise<{
  enabled: boolean
  senderPhone: string | null
  vaultEntryName: string
  recent: LeadAlertRow[]
  noEinClients: NoEinClientRow[]
  /** Sub-accounts that posted at least once in 30 days — i.e. have the workflow. */
  reportingSubAccounts30d: number
}> {
  const since = new Date(Date.now() - 30 * 86_400_000)
  const [config, rows, clients, reporting] = await Promise.all([
    prisma.clientAlertsConfig.upsert({ where: { id: 'singleton' }, create: {}, update: {} }),
    prisma.leadAlert.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { client: { select: { name: true } } },
    }),
    prisma.client.findMany({
      where: { einStatus: 'none', active: true },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        contactPhone: true,
        ghlLocationId: true,
        leadAlerts: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true, status: true } },
      },
    }),
    prisma.leadAlert.findMany({
      where: { createdAt: { gte: since } },
      distinct: ['locationId'],
      select: { locationId: true },
    }),
  ])
  return {
    enabled: config.leadAlertsEnabled,
    senderPhone: config.senderPhone,
    vaultEntryName: config.vaultEntryName,
    recent: rows.map((r) => ({
      id: r.id,
      status: r.status,
      reason: r.reason,
      errorMessage: r.errorMessage,
      clientId: r.clientId,
      clientName: r.client?.name ?? null,
      locationId: r.locationId,
      locationName: text(rec(rec(r.payload)?.location)?.name),
      leadName: r.leadName,
      leadPhone: r.leadPhone,
      source: r.source,
      recipientPhone: r.recipientPhone,
      createdAt: r.createdAt.toISOString(),
      deliveredAt: r.deliveredAt?.toISOString() ?? null,
    })),
    noEinClients: clients.map((c) => ({
      id: c.id,
      name: c.name,
      contactPhone: c.contactPhone,
      linked: !!c.ghlLocationId,
      lastLeadAt: c.leadAlerts[0]?.createdAt.toISOString() ?? null,
      lastStatus: c.leadAlerts[0]?.status ?? null,
    })),
    reportingSubAccounts30d: reporting.length,
  }
}
