/**
 * Twilio SMS wrapper.
 *
 * Credentials come from the vault (via name lookup), not env vars — that's
 * the whole point of building the vault first. The outbound phone number
 * stays in env (TWILIO_FROM_NUMBER) because it's not sensitive.
 *
 * Vault entries this module expects (names must match exactly):
 *   - "Twilio Account SID"
 *   - "Twilio Auth Token"
 */
import twilio from 'twilio'
import { getSecretByName } from './vault-service'

export async function sendSms(params: {
  to: string // E.164, e.g. +16035026226
  body: string
}): Promise<{ sid: string; status: string; from: string }> {
  const from = process.env.TWILIO_FROM_NUMBER
  if (!from) {
    throw new Error('TWILIO_FROM_NUMBER env var is not set.')
  }

  const [sid, token] = await Promise.all([
    getSecretByName('Twilio Account SID'),
    getSecretByName('Twilio Auth Token'),
  ])

  const client = twilio(sid, token)
  const message = await client.messages.create({
    to: params.to,
    from,
    body: params.body,
  })

  return { sid: message.sid, status: message.status, from }
}

/**
 * Lightweight E.164 validation — Twilio rejects malformed numbers, but
 * surfacing a clean error here avoids a round-trip and a less friendly
 * Twilio response.
 */
export function isValidE164(phone: string): boolean {
  return /^\+[1-9]\d{1,14}$/.test(phone)
}
