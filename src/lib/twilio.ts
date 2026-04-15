/**
 * Twilio SMS wrapper — used by the scheduled brief cron to text team members.
 *
 * On the trial plan, the destination number must be verified as a Caller ID
 * in the Twilio console. Messages will include a "Sent from your Twilio trial
 * account" prefix until the account is upgraded.
 */
import twilio from 'twilio'

let cachedClient: ReturnType<typeof twilio> | null = null

function getClient() {
  if (cachedClient) return cachedClient
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !token) {
    throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set to send SMS.')
  }
  cachedClient = twilio(sid, token)
  return cachedClient
}

export async function sendSms(params: {
  to: string // E.164 format, e.g. +16035026226
  body: string
}): Promise<{ sid: string; status: string }> {
  const from = process.env.TWILIO_FROM_NUMBER
  if (!from) throw new Error('TWILIO_FROM_NUMBER is not set.')

  const client = getClient()
  const message = await client.messages.create({
    to: params.to,
    from,
    body: params.body,
  })

  return { sid: message.sid, status: message.status }
}

export function isTwilioConfigured(): boolean {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER)
}
