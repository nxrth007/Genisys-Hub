import twilio from 'twilio'
import { prisma } from '@/lib/prisma'
import { getSecretByName } from '@/lib/vault-service'
import { HlInputError } from './http'

/**
 * Twilio for Hell-level: the Hub's own Twilio account (Vault "Twilio Account
 * SID" + "Twilio Auth Token", the same ones src/lib/twilio.ts uses). Numbers
 * are bought into it per sub-account and pointed at the Hub's webhooks, so
 * texts and calls to a client's number land in that client's sub-account.
 */

export type TwilioClient = ReturnType<typeof twilio>

let cached: { client: TwilioClient; token: string; at: number } | null = null
const CACHE_MS = 5 * 60_000

async function creds(): Promise<{ client: TwilioClient; token: string }> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached
  let sid: string
  let token: string
  try {
    ;[sid, token] = await Promise.all([getSecretByName('Twilio Account SID'), getSecretByName('Twilio Auth Token')])
  } catch {
    throw new HlInputError('Twilio isn’t set up: add "Twilio Account SID" and "Twilio Auth Token" to the Vault.')
  }
  cached = { client: twilio(sid.trim(), token.trim()), token: token.trim(), at: Date.now() }
  return cached
}

export async function twilioClient(): Promise<TwilioClient> {
  return (await creds()).client
}

/** Where Twilio reaches the Hub. */
export function publicBase(): string {
  return (process.env.AUTH_URL || 'https://genisys-hub.onrender.com').replace(/\/+$/, '')
}

export const HOOKS = {
  sms: '/api/hl/twilio/sms',
  voice: '/api/hl/twilio/voice',
  dial: '/api/hl/twilio/dial',
  status: '/api/hl/twilio/status',
} as const

export const hookUrl = (path: string) => `${publicBase()}${path}`

/** Form fields of a Twilio webhook request. */
export async function twilioParams(req: Request): Promise<Record<string, string>> {
  const form = await req.formData().catch(() => null)
  const out: Record<string, string> = {}
  form?.forEach((v, k) => {
    if (typeof v === 'string') out[k] = v
  })
  return out
}

/**
 * Is this really Twilio? Checks X-Twilio-Signature against the public URL
 * Twilio called (the Hub sits behind Render's proxy, so req.url is internal).
 */
export async function isFromTwilio(req: Request, params: Record<string, string>): Promise<boolean> {
  const signature = req.headers.get('x-twilio-signature')
  if (!signature) return false
  const u = new URL(req.url)
  const { token } = await creds()
  return twilio.validateRequest(token, signature, `${publicBase()}${u.pathname}${u.search}`, params)
}

export type AvailableNumber = { number: string; friendly: string; locality: string | null; region: string | null }

export async function searchNumbers(o: { kind: 'toll_free' | 'local'; areaCode?: string; contains?: string }): Promise<AvailableNumber[]> {
  const client = await twilioClient()
  const area = (o.areaCode ?? '').replace(/\D/g, '')
  const contains = (o.contains ?? '').replace(/[^\d*]/g, '')
  const opts = { limit: 20, smsEnabled: true, voiceEnabled: true, ...(contains ? { contains } : {}) }
  const list =
    o.kind === 'toll_free'
      ? await client.availablePhoneNumbers('US').tollFree.list(opts)
      : await client.availablePhoneNumbers('US').local.list({ ...opts, ...(area.length === 3 ? { areaCode: Number(area) } : {}) })
  return list.map((n) => ({ number: n.phoneNumber, friendly: n.friendlyName, locality: n.locality || null, region: n.region || null }))
}

/** Buy a number into the Hub's Twilio account and point it at Hell-level's webhooks. */
export async function buyNumber(accountId: string, number: string, kind: 'toll_free' | 'local') {
  const account = await prisma.hlAccount.findUnique({ where: { id: accountId }, select: { name: true } })
  if (!account) throw new HlInputError('Sub-account not found.')
  if (!/^\+1\d{10}$/.test(number)) throw new HlInputError('Pick a number from the search results.')
  const client = await twilioClient()
  const bought = await client.incomingPhoneNumbers.create({
    phoneNumber: number,
    friendlyName: `Hell-level: ${account.name}`.slice(0, 64),
    smsUrl: hookUrl(HOOKS.sms),
    smsMethod: 'POST',
    voiceUrl: hookUrl(HOOKS.voice),
    voiceMethod: 'POST',
  })
  const hasDefault = await prisma.hlPhoneNumber.count({ where: { accountId, status: 'active', isDefault: true } })
  return prisma.hlPhoneNumber.create({
    data: {
      accountId,
      number: bought.phoneNumber,
      providerSid: bought.sid,
      kind,
      isDefault: !hasDefault,
    },
  })
}

/** Point an existing number's webhooks back at the Hub (after a manual change in Twilio, or an older number). */
export async function repointNumber(providerSid: string): Promise<void> {
  const client = await twilioClient()
  await client.incomingPhoneNumbers(providerSid).update({
    smsUrl: hookUrl(HOOKS.sms),
    smsMethod: 'POST',
    voiceUrl: hookUrl(HOOKS.voice),
    voiceMethod: 'POST',
  })
}

/** Give a number back to Twilio. Irreversible: the number can be bought by someone else. */
export async function releaseNumber(numberId: string): Promise<void> {
  const row = await prisma.hlPhoneNumber.findUnique({ where: { id: numberId } })
  if (!row || row.status !== 'active') throw new HlInputError('That number isn’t active.')
  if (row.providerSid) {
    const client = await twilioClient()
    await client.incomingPhoneNumbers(row.providerSid).remove()
  }
  await prisma.hlPhoneNumber.update({ where: { id: numberId }, data: { status: 'released', isDefault: false } })
}

export async function sendTwilioSms(o: { from: string; to: string; body: string }): Promise<{ sid: string; status: string }> {
  const client = await twilioClient()
  const m = await client.messages.create({ from: o.from, to: o.to, body: o.body, statusCallback: hookUrl(HOOKS.status) })
  return { sid: m.sid, status: m.status }
}

export type TwilioOverview = {
  ok: boolean
  error: string | null
  accountName: string | null
  accountStatus: string | null
  /** Trust Hub business profiles: toll-free verification needs one that Twilio approved. */
  profiles: { sid: string; name: string; status: string }[]
  /** The Hub's own sending number (TWILIO_FROM_NUMBER), used for owner texts when a sub-account has no approved number. */
  hubNumber: string | null
}

export async function twilioOverview(): Promise<TwilioOverview> {
  const hubNumber = process.env.TWILIO_FROM_NUMBER ?? null
  try {
    const client = await twilioClient()
    const acct = await client.api.v2010.accounts(client.accountSid).fetch()
    const profiles = await client.trusthub.v1.customerProfiles
      .list({ limit: 20 })
      .then((list) => list.map((p) => ({ sid: p.sid, name: p.friendlyName, status: p.status })))
      .catch(() => [])
    return { ok: true, error: null, accountName: acct.friendlyName, accountStatus: acct.status, profiles, hubNumber }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), accountName: null, accountStatus: null, profiles: [], hubNumber }
  }
}

/** TwiML-safe text. */
export const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function twiml(body: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, { headers: { 'content-type': 'text/xml' } })
}
