import { after } from 'next/server'
import { prisma } from '@/lib/prisma'
import { contactReplied, fireTrigger } from '@/lib/hl/automation'
import { readProfile } from '@/lib/hl/accounts'
import { recordInboundSms, textingReady } from '@/lib/hl/messages'
import { forwardTextBody, ownerPhones } from '@/lib/hl/number-plan'
import { noteOwnerAlert } from '@/lib/hl/owner-alerts'
import { handleOwnerText } from '@/lib/hl/owner-text'
import { isFromTwilio, sendTwilioSms, twilioParams, twiml } from '@/lib/hl/twilio'
import { genisysSender, isClientOwnerPhone } from '@/lib/hl/genisys-sender'

/**
 * POST /api/hl/twilio/sms: a text to a Genisys OS number (Twilio's
 * messaging webhook). Public, so the Twilio signature is the access check.
 * Answers empty TwiML (no auto-reply); automations run after the response.
 *
 * A text from the owner's own phone (the number's forwarding phones, the
 * profile's business or notification phone) isn't a lead: no automations,
 * no forwarding. Nor is a client's text to Genisys's own number (Lead
 * Genisys's): that's them answering an owner alert or a forwarded text, which
 * go out from it. Those texts are the owner's instructions instead
 * (src/lib/hl/owner-text.ts): a photo for their website, DONE for a review
 * request, or an answer to the lead they were last told about. A lead's text
 * is also forwarded to the number's forwardTextsTo, from Genisys's own
 * number, so a reply to the forward can never land in the client's
 * sub-account as a lead.
 */
export async function POST(req: Request) {
  const p = await twilioParams(req)
  if (!(await isFromTwilio(req, p))) return new Response('Forbidden', { status: 403 })
  const number = await prisma.hlPhoneNumber.findFirst({ where: { number: p.To, status: 'active' } })
  if (!number || !p.From || !p.MessageSid) return twiml('')
  const media = Array.from({ length: Math.min(10, Number(p.NumMedia) || 0) }, (_, i) => p[`MediaUrl${i}`]).filter(Boolean)
  const account = await prisma.hlAccount.findUnique({ where: { id: number.accountId }, select: { id: true, name: true, profile: true, clientId: true } })
  const profile = readProfile(account?.profile)
  const fromOwner = ownerPhones(number, profile).has(p.From) || (!!account && !account.clientId && (await isClientOwnerPhone(p.From)))
  const r = await recordInboundSms({ accountId: number.accountId, from: p.From, to: p.To, body: p.Body ?? '', sid: p.MessageSid, media, owner: fromOwner })
  if (!r.duplicate && !r.stop && !r.start && fromOwner && account) {
    after(() =>
      handleOwnerText({ number, numberAccount: { id: account.id, clientId: account.clientId, name: account.name, profile }, from: p.From, body: p.Body ?? '', media }).catch((err) =>
        console.error('[genisys-os] owner text failed:', err instanceof Error ? err.message : err),
      ),
    )
  }
  if (!r.duplicate && !r.stop && !fromOwner && number.forwardTextsTo && number.forwardTextsTo !== p.From) {
    const to = number.forwardTextsTo
    after(async () => {
      // From the business number once it can text, so the owner's reply there reaches the lead; until then from Genisys's.
      const relay = textingReady(number).ok
      const from = relay ? number.number : (await genisysSender())?.number
      if (!from) return console.warn('[genisys-os] text forward skipped: Lead Genisys has no approved number to send it from')
      const name = [r.contact.firstName, r.contact.lastName].filter(Boolean).join(' ')
      const body = forwardTextBody({ business: profile.businessName || account?.name || 'Your business', from: p.From, name, body: p.Body ?? '', media: media.length, relay })
      try {
        await sendTwilioSms({ from, to, body })
        await noteOwnerAlert(number.accountId, [to], r.contact.id)
      } catch (err) {
        console.warn('[genisys-os] text forward failed:', err instanceof Error ? err.message : err)
      }
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
        console.error('[genisys-os] inbound sms automations failed:', err)
      }
    })
  }
  return twiml('')
}
