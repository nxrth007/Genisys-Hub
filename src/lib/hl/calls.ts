import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { fireTrigger } from './automation'
import { upsertContact } from './contacts'
import { HOOKS, hookUrl, xml } from './twilio'

/**
 * Calls to a sub-account's number (Twilio's voice webhooks).
 *
 * With a forward-to number, the call rings the owner for 25 seconds. When
 * whisper is on, whoever picks up hears "press any key to connect": a person
 * presses a key, a voicemail box doesn't, so a call the owner's voicemail
 * swallows still counts as missed. Without a forward-to number the line is a
 * missed-call catcher (the owner's own phone forwards here when they don't
 * pick up), so every call is missed.
 *
 * A missed call fires the "Missed call" automations once the caller hangs up.
 */

const SORRY = 'Sorry we missed your call. We will text you right back.'

type CallMeta = { accepted?: boolean; dialStatus?: string; duration?: number; forwardedTo?: string | null; newContact?: boolean }

async function callRow(messageId: string) {
  return prisma.hlMessage.findUnique({ where: { id: messageId } })
}

/** The incoming-call webhook: who called which number. Returns the TwiML body and, for a straight-away miss, the work to do after answering Twilio. */
export async function incomingCall(p: Record<string, string>): Promise<{ twiml: string; after?: () => Promise<void> }> {
  const to = p.To
  const from = p.From
  const number = await prisma.hlPhoneNumber.findFirst({ where: { number: to, status: 'active' } })
  if (!number) return { twiml: '<Say>This number is not in service.</Say><Hangup/>' }
  const caller = /^\+\d{8,15}$/.test(from ?? '') ? from : null
  if (!caller) {
    // Blocked or anonymous caller: nothing to text back.
    return number.forwardTo ? { twiml: `<Dial timeout="25">${xml(number.forwardTo)}</Dial>` } : { twiml: `<Say>${SORRY}</Say><Hangup/>` }
  }
  // Calling first counts as wanting a reply: the text-back is the conversation they started.
  const { contact, created } = await upsertContact(number.accountId, { phone: caller, source: 'call', consent: true })
  const existing = p.CallSid ? await prisma.hlMessage.findUnique({ where: { providerSid: p.CallSid } }) : null
  const msg =
    existing ??
    (await prisma.hlMessage.create({
      data: {
        accountId: number.accountId,
        contactId: contact.id,
        direction: 'inbound',
        channel: 'call',
        status: 'ringing',
        from: caller,
        to,
        providerSid: p.CallSid || null,
        meta: { forwardedTo: number.forwardTo, newContact: created } as Prisma.InputJsonValue,
      },
    }))
  await prisma.hlContact.update({ where: { id: contact.id }, data: { lastMessageAt: new Date(), lastMessage: 'Incoming call' } })

  if (!number.forwardTo) {
    return {
      twiml: `<Say>${SORRY}</Say><Hangup/>`,
      after: () => markMissed(msg.id, number.accountId, contact.id, created, 'catcher'),
    }
  }
  const action = `${hookUrl(HOOKS.dial)}?m=${msg.id}`
  const target = number.whisper
    ? `<Number url="${xml(`${hookUrl('/api/hl/twilio/whisper')}?m=${msg.id}`)}" method="POST">${xml(number.forwardTo)}</Number>`
    : xml(number.forwardTo)
  return { twiml: `<Dial timeout="25" action="${xml(action)}" method="POST">${target}</Dial>` }
}

/** What the owner hears when they pick up a forwarded call. */
export function whisperPrompt(messageId: string): string {
  const accept = `${hookUrl('/api/hl/twilio/whisper')}?m=${messageId}&accept=1`
  return `<Gather numDigits="1" timeout="8" action="${xml(accept)}" method="POST"><Say>Call from your business line. Press any key to connect.</Say></Gather><Hangup/>`
}

/** The owner pressed a key: connect, and remember it was a person. */
export async function acceptCall(messageId: string): Promise<void> {
  const row = await callRow(messageId)
  if (!row) return
  await prisma.hlMessage.update({ where: { id: row.id }, data: { meta: { ...((row.meta as CallMeta) ?? {}), accepted: true } as Prisma.InputJsonValue } })
}

/** The forwarded leg ended (Dial's action): answered, or missed. */
export async function dialFinished(messageId: string, p: Record<string, string>): Promise<{ twiml: string; after?: () => Promise<void> }> {
  const row = await callRow(messageId)
  if (!row) return { twiml: '<Hangup/>' }
  const number = row.to ? await prisma.hlPhoneNumber.findFirst({ where: { number: row.to } }) : null
  const meta = (row.meta as CallMeta) ?? {}
  const status = p.DialCallStatus ?? ''
  const answered = status === 'completed' && (number?.whisper ? !!meta.accepted : true)
  const duration = Number(p.DialCallDuration ?? 0) || 0
  if (answered) {
    await prisma.hlMessage.update({
      where: { id: row.id },
      data: { status: 'answered', body: `Answered call (${Math.round(duration / 60) || 1} min)`, meta: { ...meta, dialStatus: status, duration } as Prisma.InputJsonValue },
    })
    await prisma.hlContact.update({ where: { id: row.contactId }, data: { lastMessage: 'Answered call' } })
    return { twiml: '<Hangup/>' }
  }
  await prisma.hlMessage.update({ where: { id: row.id }, data: { meta: { ...meta, dialStatus: status } as Prisma.InputJsonValue } })
  return {
    twiml: `<Say>${SORRY}</Say><Hangup/>`,
    after: () => markMissed(row.id, row.accountId, row.contactId, !!meta.newContact, status || 'no-answer'),
  }
}

async function markMissed(messageId: string, accountId: string, contactId: string, created: boolean, why: string): Promise<void> {
  // Once per call, however many times Twilio retries a webhook.
  const flipped = await prisma.hlMessage.updateMany({ where: { id: messageId, status: { not: 'missed' } }, data: { status: 'missed', body: 'Missed call' } })
  if (!flipped.count) return
  await prisma.hlContact.update({ where: { id: contactId }, data: { lastMessageAt: new Date(), lastMessage: 'Missed call', unread: { increment: 1 } } })
  const row = await callRow(messageId)
  const call = { from: row?.from ?? null, to: row?.to ?? null, why }
  if (created) await fireTrigger(accountId, contactId, { type: 'contact_created', context: { call } })
  await fireTrigger(accountId, contactId, { type: 'missed_call', context: { call } })
}
