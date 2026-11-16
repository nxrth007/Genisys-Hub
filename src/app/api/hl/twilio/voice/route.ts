import { after } from 'next/server'
import { incomingCall } from '@/lib/hl/calls'
import { isFromTwilio, twilioParams, twiml } from '@/lib/hl/twilio'

/** POST /api/hl/twilio/voice: a call to a Genisys OS number. Rings the owner, or catches it as missed (src/lib/hl/calls.ts). */
export async function POST(req: Request) {
  const p = await twilioParams(req)
  if (!(await isFromTwilio(req, p))) return new Response('Forbidden', { status: 403 })
  try {
    const r = await incomingCall(p)
    if (r.after) {
      const work = r.after
      after(() => work().catch((err) => console.error('[genisys-os] missed call automations failed:', err)))
    }
    return twiml(r.twiml)
  } catch (err) {
    console.error('[genisys-os] voice webhook failed:', err)
    return twiml('<Say>Sorry, something went wrong. Please try again later.</Say><Hangup/>')
  }
}
