import { after } from 'next/server'
import { prisma } from '@/lib/prisma'
import { contactReplied, fireTrigger } from '@/lib/hl/automation'
import { readProfile } from '@/lib/hl/accounts'
import { recordInboundSms } from '@/lib/hl/messages'
import { forwardTextBody, ownerPhones } from '@/lib/hl/number-plan'
import { isFromTwilio, sendTwilioSms, twilioParams, twiml } from '@/lib/hl/twilio'

/**
 * POST /api/hl/twilio/sms: a text to a Hell-level number (Twilio's
 * messaging webhook). Public, so the Twilio signature is the access check.
 * Answers empty TwiML (no auto-reply); automations run after the response.
 *
 * A text from the owner's own phone (the number's forwarding phones, the
 * profile's business or notification phone) isn't a lead: no automations,
 * no forwarding. A lead's text is also forwarded to the number's
 * forwardTextsTo, from the Hub's own number, so a reply to the forward can
 * never land back here as a lead.
 */
export async function POST(req: Request) {
  const p = await twilioParams(req)
  if (!(await isFromTwilio(req, p))) return new Response('Forbidden', { status: 403 })
  const number = await prisma.hlPhoneNumber.findFirst({ where: { number: p.To, status: 'active' } })
  if (!number || !p.From || !p.MessageSid) return twiml('')
  const media = Array.from({ length: Math.min(10, Number(p.NumMedia) || 0) }, (_, i) => p[`MediaUrl${i}`]).filter(Boolean)
  const r = await recordInboundSms({ accountId: number.accountId, from: p.From, to: p.To, body: p.Body ?? '', sid: p.MessageSid, media })
  const account = await prisma.hlAccount.findUnique({ where: { id: number.accountId }, select: { name: true, profile: true } })
  const profile = readProfile(account?.profile)
  const fromOwner = ownerPhones(number, profile).has(p.From)
  if (!r.duplicate && !r.stop && !fromOwner && number.forwardTextsTo && number.forwardTextsTo !== p.From) {
    const hub = process.env.TWILIO_FROM_NUMBER
    const to = number.forwardTextsTo
    after(async () => {
      if (!hub) return console.warn('[hell-level] text forward skipped: TWILIO_FROM_NUMBER is not set')
      const name = [r.contact.firstName, r.contact.lastName].filter(Boolean).join(' ')
      const body = forwardTextBody({ business: profile.businessName || account?.name || 'Your business', from: p.From, name, body: p.Body ?? '', media: media.length })
      await sendTwilioSms({ from: hub, to, body }).catch((err) => console.warn('[hell-level] text forward failed:', err instanceof Error ? err.message : err))
    })
  }
  if (!r.duplicate && !r.stop && !fromOwner) {
    after(async () => {
      try {
        // Runs the reply starts below are newer than this; contactReplied leaves them be.
        const at = new Date()
        if (r.created) await fireTrigger(number.accountId, r.contact.id, { type: 'contact_created' })
        await fireTrigger(number.accountId, r.contact.id, { type: 'inbound_sms', text: p.Body ?? '', context: { message: p.Body ?? '' } })
        await contactReplied(number.accountId, r.contact.id, at)
      } catch (err) {
        console.error('[hell-level] inbound sms automations failed:', err)
      }
    })
  }
  return twiml('')
}
