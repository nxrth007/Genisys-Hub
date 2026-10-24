import { NextResponse } from 'next/server'
import { hlError, hlGuard, jsonBody, str } from '@/lib/hl/http'
import { twilioOverview } from '@/lib/hl/twilio'
import { readTwilioSettings, saveTwilioSettings } from '@/lib/hl/verification'

/** GET: is Twilio connected, and is Genisys's business profile approved (toll-free verification needs it)? */
export async function GET() {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const [overview, settings] = await Promise.all([twilioOverview(), readTwilioSettings()])
  return NextResponse.json({ ...overview, settings })
}

/** PUT { customerProfileSid?, notificationEmail? } */
export async function PUT(req: Request) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  try {
    const body = await jsonBody(req)
    const current = await readTwilioSettings()
    await saveTwilioSettings({
      customerProfileSid: 'customerProfileSid' in body ? (str(body.customerProfileSid) ?? undefined) : current.customerProfileSid,
      notificationEmail: 'notificationEmail' in body ? (str(body.notificationEmail) ?? undefined) : current.notificationEmail,
    })
    return NextResponse.json({ settings: await readTwilioSettings() })
  } catch (err) {
    return hlError(err, 'twilio settings')
  }
}
