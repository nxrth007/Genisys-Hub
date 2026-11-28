import { prisma } from '@/lib/prisma'
import { sendEmail } from '@/lib/gmail'
import { getWriterAccountEmail } from '@/lib/drive'
import type { HlPhoneNumber, Prisma } from '@/generated/prisma/client'
import { readProfile } from './accounts'
import { upsertContact } from './contacts'
import { sendTwilioSms } from './twilio'
import { genisysSender } from './genisys-sender'
import { noteOwnerAlert } from './owner-alerts'
import { notifyInbox } from './push'

/**
 * Texts and emails. Texts to contacts go out from the sub-account's own
 * number and land in its conversation; owner notifications go to the
 * profile's notification phone/email and aren't part of any conversation.
 */

export type SendResult = { ok: boolean; detail: string; messageId?: string; /** Why nothing was tried: a promotion for someone who didn't agree to promotions. */ refused?: 'promotion' }

/** The number a sub-account texts from: its default active number, else any active one. */
export async function sendingNumber(accountId: string): Promise<HlPhoneNumber | null> {
  return prisma.hlPhoneNumber.findFirst({
    where: { accountId, status: 'active' },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  })
}

/**
 * Can this number text people yet? A toll-free number can't until Twilio
 * approves its verification, and a local one until its A2P campaign is
 * approved (carriers block unregistered local-number texts outright).
 */
export function textingReady(n: Pick<HlPhoneNumber, 'kind' | 'verificationStatus'> | null): { ok: boolean; reason: string | null } {
  if (!n) return { ok: false, reason: 'This sub-account has no phone number yet (Settings → Phone Numbers).' }
  if (n.verificationStatus !== 'approved') {
    return {
      ok: false,
      reason:
        n.kind === 'toll_free'
          ? 'Texting isn’t approved yet: the number’s toll-free verification is still pending (Settings → Phone Numbers).'
          : 'Texting isn’t approved yet: the local number’s A2P registration isn’t finished (Settings → Phone Numbers).',
    }
  }
  return { ok: true, reason: null }
}

const OPT_OUT = 'Reply STOP to opt out.'

async function touch(contactId: string, preview: string, unread = false) {
  const contact = await prisma.hlContact.update({
    where: { id: contactId },
    data: { lastMessageAt: new Date(), lastMessage: preview.slice(0, 200), ...(unread ? { unread: { increment: 1 } } : {}) },
  })
  // A lead's text: the phones of everyone on the sub-account buzz (src/lib/hl/push.ts).
  if (unread) notifyInbox(contact, 'sms', preview)
}

/**
 * Text a contact from the sub-account's number. Refuses when they opted out,
 * have no number, or never agreed to texts (automations) / never wrote or
 * called (staff sends without recorded consent). A promotion (`marketing`)
 * also needs their yes to promotions. The first text a contact ever gets
 * carries the opt-out line carriers expect.
 */
export async function sendSmsToContact(o: { accountId: string; contactId: string; body: string; by: string; runId?: string; marketing?: boolean }): Promise<SendResult> {
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
  // A promotion (an offer or discount) needs its own yes: the separate promotions box on the form. It's what the
  // consent wording promises, and what the number's texting registration tells the carriers.
  if (o.marketing && !contact.marketingConsent) return { ok: false, detail: 'Not sent: this is a promotion, and they didn’t tick the promotions box (texts about their own job still go)', refused: 'promotion' }
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
    // Twilio refused the number outright (invalid, or not a mobile): GHL's "Twilio validation error" trigger.
    const code = (err as { code?: number }).code
    if (code === 21211 || code === 21614) {
      void import('./automation').then((m) => m.fireTrigger(o.accountId, contact.id, { type: 'sms_error' })).catch((e) => console.error('[genisys-os] sms_error trigger failed:', e))
    }
    return { ok: false, detail, messageId: msg.id }
  }
}

/**
 * An owner notification text. From the sub-account's number once it can text;
 * until then from Genisys's own approved number (Lead Genisys's, see
 * genisys-sender.ts), so owners hear about leads even before verification
 * finishes, or before they have a number at all. `about` is the lead it's
 * about: a reply from the owner's phone then goes to them (owner-text.ts).
 */
export async function sendInternalSms(accountId: string, to: string[], body: string, about?: { contactId: string }): Promise<SendResult> {
  if (!to.length) return { ok: false, detail: 'No notification phone on the sub-account (Settings → Business Profile)' }
  const number = await sendingNumber(accountId)
  const from = textingReady(number).ok && number ? number.number : (await genisysSender())?.number
  if (!from) return { ok: false, detail: 'No number to text from: this sub-account’s number can’t text yet, and Lead Genisys has no approved number either' }
  const results: string[] = []
  const reached: string[] = []
  let ok = false
  for (const phone of to) {
    try {
      await sendTwilioSms({ from, to: phone, body })
      ok = true
      reached.push(phone)
      results.push(`sent to ${phone}`)
    } catch (err) {
      results.push(`${phone}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (about && reached.length) await noteOwnerAlert(accountId, reached, about.contactId).catch((err) => console.warn('[genisys-os] owner alert not noted:', err instanceof Error ? err.message : err))
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

/** The owner's own opt-out and opt-in words on a Genisys OS number; "yes" is an answer to a lead, not an opt-in. */
export const OWNER_STOP_WORDS = /^(stop|stopall|unsubscribe|optout|opt out)$/i
export const OWNER_START_WORDS = /^(start|unstop)$/i

/**
 * A text from a contact (Twilio's inbound webhook). Writing first counts as
 * consent to texts back; STOP and its synonyms opt them out, START opts them
 * back in. Returns the contact so the caller can fire automations. The
 * owner's own texts (`owner`) are kept too, but record no consent, flip no
 * opt-out and don't count as unread: they aren't a lead's.
 */
export async function recordInboundSms(o: { accountId: string; from: string; to: string; body: string; sid: string; media: string[]; owner?: boolean }) {
  const word = o.body.trim().replace(/[.!]+$/, '')
  const stop = o.owner ? OWNER_STOP_WORDS.test(word) : STOP_WORDS.test(word)
  const start = o.owner ? OWNER_START_WORDS.test(word) : START_WORDS.test(word)
  const { contact, created } = await upsertContact(o.accountId, { phone: o.from, source: 'sms', consent: !stop && !o.owner })
  if (!o.owner && stop && !contact.dnd) await prisma.hlContact.update({ where: { id: contact.id }, data: { dnd: true } })
  if (!o.owner && start && contact.dnd) await prisma.hlContact.update({ where: { id: contact.id }, data: { dnd: false, smsConsent: true, smsConsentAt: new Date() } })
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
    await touch(contact.id, o.body || (o.media.length ? '📎 Attachment' : ''), !o.owner)
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
