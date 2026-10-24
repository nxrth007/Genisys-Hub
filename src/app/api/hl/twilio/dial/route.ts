import { after } from 'next/server'
import { dialFinished } from '@/lib/hl/calls'
import { isFromTwilio, twilioParams, twiml } from '@/lib/hl/twilio'

/** POST /api/hl/twilio/dial?m=<call message id>: the forwarded call ended; answered or missed. */
export async function POST(req: Request) {
  const p = await twilioParams(req)
  if (!(await isFromTwilio(req, p))) return new Response('Forbidden', { status: 403 })
  const messageId = new URL(req.url).searchParams.get('m') ?? ''
  try {
    const r = await dialFinished(messageId, p)
    if (r.after) {
      const work = r.after
      after(() => work().catch((err) => console.error('[hell-level] missed call automations failed:', err)))
    }
    return twiml(r.twiml)
  } catch (err) {
    console.error('[hell-level] dial webhook failed:', err)
    return twiml('<Hangup/>')
  }
}
