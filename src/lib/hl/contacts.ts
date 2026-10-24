import { prisma } from '@/lib/prisma'
import type { HlContact, Prisma } from '@/generated/prisma/client'
import { splitName, toE164 } from './phone'

/**
 * Contacts: found by phone, then email, within the sub-account, so a lead
 * who fills the form, then calls, then texts stays one contact with one
 * conversation. Nothing here fires automations; callers do, with the
 * `created` flag.
 */

export type ContactInput = {
  firstName?: string | null
  lastName?: string | null
  fullName?: string | null
  phone?: string | null
  email?: string | null
  source?: string | null
  /** True records texting consent (form checkbox, or they called/texted first). */
  consent?: boolean
  /** True records consent to promotional texts (the separate marketing box). */
  marketingConsent?: boolean
  fields?: Record<string, unknown>
  tags?: string[]
}

const cleanEmail = (e: string | null | undefined) => {
  const s = (e ?? '').trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null
}

export function contactName(c: { firstName?: string | null; lastName?: string | null; phone?: string | null; email?: string | null }): string {
  return [c.firstName, c.lastName].filter(Boolean).join(' ') || c.phone || c.email || 'Unknown'
}

export async function upsertContact(accountId: string, input: ContactInput): Promise<{ contact: HlContact; created: boolean }> {
  const phone = toE164(input.phone)
  const email = cleanEmail(input.email)
  const split = input.fullName ? splitName(input.fullName) : { firstName: null, lastName: null }
  const firstName = (input.firstName ?? split.firstName)?.trim() || null
  const lastName = (input.lastName ?? split.lastName)?.trim() || null
  const tags = (input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)

  const existing =
    (phone ? await prisma.hlContact.findFirst({ where: { accountId, phone }, orderBy: { createdAt: 'asc' } }) : null) ??
    (email ? await prisma.hlContact.findFirst({ where: { accountId, email }, orderBy: { createdAt: 'asc' } }) : null)

  if (existing) {
    const data: Prisma.HlContactUpdateInput = {}
    if (!existing.firstName && firstName) data.firstName = firstName
    if (!existing.lastName && lastName) data.lastName = lastName
    if (!existing.phone && phone) data.phone = phone
    if (!existing.email && email) data.email = email
    if (input.consent && !existing.smsConsent) {
      data.smsConsent = true
      data.smsConsentAt = new Date()
    }
    if (input.marketingConsent && !existing.marketingConsent) {
      data.marketingConsent = true
      data.marketingConsentAt = new Date()
    }
    if (input.fields && Object.keys(input.fields).length) {
      data.fields = { ...((existing.fields as Record<string, unknown>) ?? {}), ...input.fields } as Prisma.InputJsonValue
    }
    const merged = [...new Set([...existing.tags, ...tags])]
    if (merged.length !== existing.tags.length) data.tags = merged
    const contact = Object.keys(data).length ? await prisma.hlContact.update({ where: { id: existing.id }, data }) : existing
    return { contact, created: false }
  }

  const contact = await prisma.hlContact.create({
    data: {
      accountId,
      firstName,
      lastName,
      phone,
      email,
      source: input.source ?? null,
      tags,
      smsConsent: !!input.consent,
      smsConsentAt: input.consent ? new Date() : null,
      marketingConsent: !!input.marketingConsent,
      marketingConsentAt: input.marketingConsent ? new Date() : null,
      fields: (input.fields ?? {}) as Prisma.InputJsonValue,
    },
  })
  return { contact, created: true }
}

/**
 * A line in the contact's conversation that isn't a text or call ("Submitted
 * Website Quote Form"). It moves the conversation to the top of the inbox.
 */
export async function logActivity(accountId: string, contactId: string, body: string, meta: Record<string, unknown> = {}, unread = true): Promise<void> {
  const now = new Date()
  await prisma.hlMessage.create({
    data: { accountId, contactId, direction: 'inbound', channel: 'activity', status: 'logged', body, meta: meta as Prisma.InputJsonValue },
  })
  await prisma.hlContact.update({
    where: { id: contactId },
    data: { lastMessageAt: now, lastMessage: body.slice(0, 200), ...(unread ? { unread: { increment: 1 } } : {}) },
  })
}

/** Add tags; returns the ones that weren't there yet (for the tag_added trigger). */
export async function addTags(contactId: string, tags: string[]): Promise<string[]> {
  const c = await prisma.hlContact.findUnique({ where: { id: contactId }, select: { tags: true } })
  if (!c) return []
  const want = tags.map((t) => t.trim().toLowerCase()).filter(Boolean)
  const fresh = want.filter((t) => !c.tags.includes(t))
  if (fresh.length) await prisma.hlContact.update({ where: { id: contactId }, data: { tags: [...c.tags, ...fresh] } })
  return fresh
}

export async function removeTags(contactId: string, tags: string[]): Promise<void> {
  const c = await prisma.hlContact.findUnique({ where: { id: contactId }, select: { tags: true } })
  if (!c) return
  const drop = new Set(tags.map((t) => t.trim().toLowerCase()))
  await prisma.hlContact.update({ where: { id: contactId }, data: { tags: c.tags.filter((t) => !drop.has(t)) } })
}
