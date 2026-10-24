import { after } from 'next/server'
import { prisma } from '@/lib/prisma'
import { fireTrigger } from '@/lib/hl/automation'
import { recordInboundSms } from '@/lib/hl/messages'
import { isFromTwilio, twilioParams, twiml } from '@/lib/hl/twilio'

/**
 * POST /api/hl/twilio/sms: a text to a Hell-level number (Twilio's
 * messaging webhook). Public, so the Twilio signature is the access check.
 * Answers empty TwiML (no auto-reply); automations run after the response.
 */
export async function POST(req: Request) {
  const p = await twilioParams(req)
  if (!(await isFromTwilio(req, p))) return new Response('Forbidden', { status: 403 })
  const number = await prisma.hlPhoneNumber.findFirst({ where: { number: p.To, status: 'active' } })
  if (!number || !p.From || !p.MessageSid) return twiml('')
  const media = Array.from({ length: Math.min(10, Number(p.NumMedia) || 0) }, (_, i) => p[`MediaUrl${i}`]).filter(Boolean)
  const r = await recordInboundSms({ accountId: number.accountId, from: p.From, to: p.To, body: p.Body ?? '', sid: p.MessageSid, media })
  if (!r.duplicate && !r.stop) {
    after(async () => {
      try {
        if (r.created) await fireTrigger(number.accountId, r.contact.id, { type: 'contact_created' })
        await fireTrigger(number.accountId, r.contact.id, { type: 'inbound_sms', text: p.Body ?? '', context: { message: p.Body ?? '' } })
      } catch (err) {
        console.error('[hell-level] inbound sms automations failed:', err)
      }
    })
  }
  return twiml('')
}
