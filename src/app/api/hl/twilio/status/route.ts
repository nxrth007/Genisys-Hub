import { prisma } from '@/lib/prisma'
import { fireTrigger } from '@/lib/hl/automation'
import { recordSmsStatus } from '@/lib/hl/messages'
import { isFromTwilio, twilioParams } from '@/lib/hl/twilio'

/** Twilio error codes people actually hit, in plain words. */
const ERRORS: Record<string, string> = {
  '30032': 'Toll-free number not verified yet: carriers block its texts until verification is approved',
  '21610': 'The recipient texted STOP to this number',
  '30007': 'Carrier filtered the message as spam',
  '30003': 'Phone unreachable (off or out of service)',
  '30005': 'Unknown or inactive phone number',
  '30006': 'Landline or unreachable carrier: can’t receive texts',
  '30008': 'Unknown carrier error',
  '30034': 'Message blocked: the number isn’t registered for texting',
  '21614': 'Not a mobile number',
}

/** Codes meaning the number itself can't take texts (not a passing carrier hiccup). */
const INVALID_NUMBER = new Set(['30003', '30005', '30006', '21614', '21211'])

/** POST /api/hl/twilio/status: delivery receipts for texts Hell-level sent. */
export async function POST(req: Request) {
  const p = await twilioParams(req)
  if (!(await isFromTwilio(req, p))) return new Response('Forbidden', { status: 403 })
  const sid = p.MessageSid || p.SmsSid
  const status = (p.MessageStatus || p.SmsStatus || '').toLowerCase()
  if (sid && status) {
    const code = p.ErrorCode
    const error = code ? `${ERRORS[code] ?? 'Delivery failed'} (Twilio ${code})` : null
    await recordSmsStatus(sid, status, error)
    // The number can't get texts at all: workflows listening for that (GHL's "Twilio validation error") run.
    if (code && INVALID_NUMBER.has(code)) {
      const m = await prisma.hlMessage.findFirst({ where: { providerSid: sid }, select: { accountId: true, contactId: true } })
      if (m?.contactId) await fireTrigger(m.accountId, m.contactId, { type: 'sms_error' }).catch((err) => console.error('[hell-level] sms_error trigger failed:', err))
    }
  }
  return new Response(null, { status: 204 })
}
