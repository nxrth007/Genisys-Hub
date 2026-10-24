import { acceptCall, whisperPrompt } from '@/lib/hl/calls'
import { isFromTwilio, twilioParams, twiml } from '@/lib/hl/twilio'

/**
 * POST /api/hl/twilio/whisper?m=<id>: played to whoever picks up the forwarded
 * call. ?accept=1 is the key press: the call connects and counts as answered.
 */
export async function POST(req: Request) {
  const p = await twilioParams(req)
  if (!(await isFromTwilio(req, p))) return new Response('Forbidden', { status: 403 })
  const sp = new URL(req.url).searchParams
  const messageId = sp.get('m') ?? ''
  if (sp.get('accept')) {
    if (p.Digits) await acceptCall(messageId)
    // Empty TwiML ends the whisper and bridges the two calls.
    return twiml(p.Digits ? '' : '<Hangup/>')
  }
  return twiml(whisperPrompt(messageId))
}
