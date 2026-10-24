import { prisma } from '@/lib/prisma'
import { sendEmail } from '@/lib/gmail'
import { getWriterAccountEmail } from '@/lib/drive'
import type { HlPhoneNumber, Prisma } from '@/generated/prisma/client'
import { readProfile } from './accounts'
import { upsertContact } from './contacts'
import { sendTwilioSms } from './twilio'

/**
 * Texts and emails. Texts to contacts go out from the sub-account's own
 * number and land in its conversation; owner notifications go to the
 * profile's notification phone/email and aren't part of any conversation.
 */

export type SendResult = { ok: boolean; detail: string; messageId?: string }

/** The number a sub-account texts from: its default active number, else any active one. */
export async function sendingNumber(accountId: string): Promise<HlPhoneNumber | null> {
  return prisma.hlPhoneNumber.findFirst({
    where: { accountId, status: 'active' },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  })
}

/** Can this number text people yet? Toll-free numbers can't until Twilio approves their verification. */
export function textingReady(n: Pick<HlPhoneNumber, 'kind' | 'verificationStatus'> | null): { ok: boolean; reason: string | null } {
  if (!n) return { ok: false, reason: 'This sub-account has no phone number yet (Settings → Phone Numbers).' }
  if (n.kind === 'toll_free' && n.verificationStatus !== 'approved') {
    return { ok: false, reason: 'Texting isn’t approved yet: the number’s toll-free verification is still pending (Settings → Phone Numbers).' }
  }
  return { ok: true, reason: null }
}

const OPT_OUT = 'Reply STOP to opt out.'

async function touch(contactId: string, preview: string, unread = false) {
  await prisma.hlContact.update({
    where: { id: contactId },
    data: { lastMessageAt: new Date(), lastMessage: preview.slice(0, 200), ...(unread ? { unread: { increment: 1 } } : {}) },
  })
}

/**
 * Text a contact from the sub-account's number. Refuses when they opted out,
 * have no number, or never agreed to texts (automations) / never wrote or
 * called (staff sends without recorded consent). The first text a contact
 * ever gets carries the opt-out line carriers expect.
 */
export async function sendSmsToContact(o: { accountId: string; contactId: string; body: string; by: string; runId?: string }): Promise<SendResult> {
  const contact = await prisma.hlContact.findUnique({ where: { id: o.contactId } })
  if (!contact || contact.accountId !== o.accountId) return { ok: false, detail: 'Contact not found' }
  if (!contact.phone) return { ok: false, detail: 'The contact has no phone number' }
  if (contact.dnd) return { ok: false, detail: 'The contact texted STOP; nothing is sent until they text START' }
  if (!contact.smsConsent) {
    return {
      ok: false,
      detail: o.by === 'automation'
        ? 'No texting consent: they didn’t tick the consent box, call or text first'
        : 'No texting consent recorded. If they agreed to texts, tick “Agreed to texts” on the contact first',
    }
  }
  const body = o.body.trim()
  if (!body) return { ok: false, detail: 'Empty message' }
  const number = await sendingNumber(o.accountId)
  const ready = textingReady(number)
  const earlier = await prisma.hlMessage.count({ where: { contactId: contact.id, channel: 'sms', direction: 'outbound', status: { notIn: ['failed', 'undelivered'] } } })
  const text = earlier === 0 && !/\bSTOP\b/.test(body) ? `${body}\n\n${OPT_OUT}` : body

  if (!ready.ok || !number) {
    const failed = await prisma.hlMessage.create({
      data: { accountId: o.accountId, contactId: contact.id, direction: 'outbound', channel: 'sms', body: text, status: 'failed', to: contact.phone, error: ready.reason, by: o.by, runId: o.runId ?? null },
    })
    await touch(contact.id, text)
    return { ok: false, detail: ready.reason ?? 'No number', messageId: failed.id }
  }

  try {
    const sent = await sendTwilioSms({ from: number.number, to: contact.phone, body: text })
    const msg = await prisma.hlMessage.create({
      data: {
        accountId: o.accountId,
        contactId: contact.id,
        direction: 'outbound',
        channel: 'sms',
        body: text,
        status: sent.status === 'queued' || sent.status === 'accepted' ? 'queued' : sent.status,
        from: number.number,
        to: contact.phone,
        providerSid: sent.sid,
        by: o.by,
        runId: o.runId ?? null,
      },
    })
    await touch(contact.id, text)
    return { ok: true, detail: `Sent to ${contact.phone}`, messageId: msg.id }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    const msg = await prisma.hlMessage.create({
      data: { accountId: o.accountId, contactId: contact.id, direction: 'outbound', channel: 'sms', body: text, status: 'failed', from: number.number, to: contact.phone, error: detail, by: o.by, runId: o.runId ?? null },
    })
    await touch(contact.id, text)
    return { ok: false, detail, messageId: msg.id }
  }
}

/**
 * An owner notification text. From the sub-account's number once it can text;
 * until then from the Hub's own Twilio number (TWILIO_FROM_NUMBER), so owners
 * hear about leads even before verification finishes.
 */
export async function sendInternalSms(accountId: string, to: string[], body: string): Promise<SendResult> {
  if (!to.length) return { ok: false, detail: 'No notification phone on the sub-account (Settings → Business Profile)' }
  const number = await sendingNumber(accountId)
  const from = textingReady(number).ok && number ? number.number : process.env.TWILIO_FROM_NUMBER
  if (!from) return { ok: false, detail: 'No number to text from: the sub-account’s number isn’t approved yet and TWILIO_FROM_NUMBER isn’t set' }
  const results: string[] = []
  let ok = false
  for (const phone of to) {
    try {
      await sendTwilioSms({ from, to: phone, body })
      ok = true
      results.push(`sent to ${phone}`)
    } catch (err) {
      results.push(`${phone}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { ok, detail: results.join('; ') }
}

/** An owner notification email, sent from the Hub's Google account. */
export async function sendInternalEmail(accountId: string, to: string[], subject: string, body: string): Promise<SendResult> {
  if (!to.length) return { ok: false, detail: 'No notification email on the sub-account (Settings → Business Profile)' }
  const account = await prisma.hlAccount.findUnique({ where: { id: accountId }, select: { profile: true, name: true } })
  const business = readProfile(account?.profile).businessName || account?.name || 'Genisys'
  const from = process.env.AGENT_APPROVAL_FROM_EMAIL || (await getWriterAccountEmail())
  const results: string[] = []
  let ok = false
  for (const address of to) {
    try {
      await sendEmail({ accountEmail: from, to: address, subject, body, fromName: `${business} Leads` })
      ok = true
      results.push(`sent to ${address}`)
    } catch (err) {
      results.push(`${address}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { ok, detail: results.join('; ') }
}

const STOP_WORDS = /^(stop|stopall|unsubscribe|cancel|end|quit|revoke|optout|opt out)$/i
const START_WORDS = /^(start|unstop|yes|subscribe)$/i

/**
 * A text from a contact (Twilio's inbound webhook). Writing first counts as
 * consent to texts back; STOP and its synonyms opt them out, START opts them
 * back in. Returns the contact so the caller can fire automations.
 */
export async function recordInboundSms(o: { accountId: string; from: string; to: string; body: string; sid: string; media: string[] }) {
  const word = o.body.trim().replace(/[.!]+$/, '')
  const stop = STOP_WORDS.test(word)
  const start = START_WORDS.test(word)
  const { contact, created } = await upsertContact(o.accountId, { phone: o.from, source: 'sms', consent: !stop })
  if (stop && !contact.dnd) await prisma.hlContact.update({ where: { id: contact.id }, data: { dnd: true } })
  if (start && contact.dnd) await prisma.hlContact.update({ where: { id: contact.id }, data: { dnd: false, smsConsent: true, smsConsentAt: new Date() } })
  const existing = await prisma.hlMessage.findUnique({ where: { providerSid: o.sid } })
  if (!existing) {
    await prisma.hlMessage.create({
      data: {
        accountId: o.accountId,
        contactId: contact.id,
        direction: 'inbound',
        channel: 'sms',
        body: o.body,
        status: 'received',
        from: o.from,
        to: o.to,
        providerSid: o.sid,
        meta: (o.media.length ? { media: o.media } : {}) as Prisma.InputJsonValue,
      },
    })
    await touch(contact.id, o.body || (o.media.length ? '📎 Attachment' : ''), true)
  }
  return { contact, created, duplicate: !!existing, stop, start }
}

/** Twilio's delivery receipts. */
export async function recordSmsStatus(sid: string, status: string, error: string | null): Promise<void> {
  await prisma.hlMessage.updateMany({
    where: { providerSid: sid, status: { notIn: ['delivered'] } },
    data: { status, ...(error ? { error } : {}) },
  })
}
