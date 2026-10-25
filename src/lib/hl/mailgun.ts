import { createHmac, timingSafeEqual } from 'node:crypto'
import { getSecretByName } from '@/lib/vault-service'
import { HlInputError } from './http'

/**
 * Mailgun, the email service Hell-level sends and receives client email
 * through (GoHighLevel's LC Email runs on it too). One Vault entry, "Mailgun
 * API Key", is all it needs: the region (US or EU) is found by trying the key,
 * and the webhook signing key is read from the account.
 *
 * API: documentation.mailgun.com (domains v4, routes v3, account webhooks v1,
 * messages v3, http_signing_key v5). Basic auth, user "api".
 */

export const VAULT_MAILGUN = 'Mailgun API Key'

const BASES = ['https://api.mailgun.net', 'https://api.eu.mailgun.net'] as const

export class MailgunError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

let conn: { key: string; base: string; at: number } | null = null

async function apiKey(): Promise<string> {
  try {
    return (await getSecretByName(VAULT_MAILGUN)).trim()
  } catch {
    throw new HlInputError(`Email isn’t connected: add “${VAULT_MAILGUN}” to the Vault (Mailgun → Settings → API Keys).`)
  }
}

const auth = (key: string) => `Basic ${Buffer.from(`api:${key}`).toString('base64')}`

/** The key and the region it belongs to (an EU key is refused by the US address, and the other way round). */
async function connection(): Promise<{ key: string; base: string }> {
  const key = await apiKey()
  if (conn && conn.key === key && Date.now() - conn.at < 3600_000) return conn
  for (const base of BASES) {
    const res = await fetch(`${base}/v4/domains?limit=1`, { headers: { authorization: auth(key) }, signal: AbortSignal.timeout(15_000) }).catch(() => null)
    if (res?.ok) {
      conn = { key, base, at: Date.now() }
      return conn
    }
    if (res && res.status !== 401 && res.status !== 403) throw new MailgunError(`Mailgun answered ${res.status}`, res.status)
  }
  throw new HlInputError(`Mailgun didn’t accept the key in the Vault (“${VAULT_MAILGUN}”). Copy a private API key from Mailgun → Settings → API Keys.`)
}

type Body = FormData | URLSearchParams | undefined

async function call<T = Record<string, unknown>>(method: string, path: string, body?: Body, timeout = 30_000): Promise<T> {
  const { key, base } = await connection()
  const res = await fetch(`${base}${path}`, { method, headers: { authorization: auth(key), accept: 'application/json' }, body, signal: AbortSignal.timeout(timeout) })
  const text = await res.text()
  let data: Record<string, unknown> = {}
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    data = { message: text.slice(0, 300) }
  }
  if (!res.ok) throw new MailgunError(String(data.message ?? data.error ?? `Mailgun answered ${res.status}`), res.status)
  return data as T
}

const form = (fields: [string, string | Blob][]) => {
  const f = new FormData()
  for (const [k, v] of fields) f.append(k, v)
  return f
}

/** Whether the key works, and which region it's in. */
export async function mailgunStatus(): Promise<{ connected: boolean; region: 'US' | 'EU' | null; error: string | null }> {
  try {
    const { base } = await connection()
    return { connected: true, region: base.includes('.eu.') ? 'EU' : 'US', error: null }
  } catch (err) {
    return { connected: false, region: null, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export type MailgunRecord = {
  type: string
  /** The full name ("mail.forte.com", "pdk1._domainkey.mail.forte.com"). */
  name: string
  value: string
  priority: number | null
  /** Mailgun's check of the live DNS: true, false, or not checked yet. */
  valid: boolean | null
  purpose: 'sending' | 'receiving'
}

type RawRecord = { record_type?: string; name?: string; value?: string; priority?: string | number; valid?: string }
type DomainResponse = { domain?: { name?: string; state?: string } | null; sending_dns_records?: RawRecord[]; receiving_dns_records?: RawRecord[] }

function records(d: DomainResponse, domain: string): MailgunRecord[] {
  const one = (r: RawRecord, purpose: MailgunRecord['purpose']): MailgunRecord => ({
    type: String(r.record_type ?? '').toUpperCase(),
    name: (r.name || domain).toLowerCase().replace(/\.$/, ''),
    value: String(r.value ?? '').trim(),
    priority: r.priority === undefined || r.priority === null || r.priority === '' ? null : Number(r.priority),
    valid: r.valid === 'valid' ? true : r.valid === 'invalid' ? false : null,
    purpose,
  })
  return [...(d.sending_dns_records ?? []).map((r) => one(r, 'sending')), ...(d.receiving_dns_records ?? []).map((r) => one(r, 'receiving'))]
}

export type MailgunDomain = { name: string; state: string; records: MailgunRecord[] }

const asDomain = (d: DomainResponse, name: string): MailgunDomain => ({ name, state: String(d.domain?.state ?? 'unverified'), records: records(d, name) })

/** Add a sending domain; Mailgun answers with the DNS records it needs. */
export async function createDomain(name: string): Promise<MailgunDomain> {
  const d = await call<DomainResponse>('POST', '/v4/domains', form([
    ['name', name],
    ['dkim_key_size', '2048'],
  ]))
  return asDomain(d, name)
}

export async function getDomain(name: string): Promise<MailgunDomain | null> {
  try {
    return asDomain(await call<DomainResponse>('GET', `/v4/domains/${encodeURIComponent(name)}`), name)
  } catch (err) {
    if (err instanceof MailgunError && err.status === 404) return null
    throw err
  }
}

/** Ask Mailgun to check the records now. */
export async function verifyDomain(name: string): Promise<MailgunDomain> {
  return asDomain(await call<DomainResponse>('PUT', `/v4/domains/${encodeURIComponent(name)}/verify`), name)
}

export async function deleteDomain(name: string): Promise<void> {
  try {
    await call('DELETE', `/v3/domains/${encodeURIComponent(name)}`)
  } catch (err) {
    if (!(err instanceof MailgunError && err.status === 404)) throw err
  }
}

// ---------------------------------------------------------------------------
// Replies in (routes) and delivery news (account webhook)
// ---------------------------------------------------------------------------

/** Everything sent to the domain is posted to `url` (parsed), and nothing else handles it. */
export async function createRoute(domain: string, url: string): Promise<string> {
  const body = new URLSearchParams()
  body.append('priority', '10')
  body.append('description', `Hell-level replies for ${domain}`)
  body.append('expression', `match_recipient(".*@${domain}")`)
  body.append('action', `forward("${url}")`)
  body.append('action', 'stop()')
  const r = await call<{ route?: { id?: string } }>('POST', '/v3/routes', body)
  if (!r.route?.id) throw new MailgunError('Mailgun didn’t return the route', 500)
  return r.route.id
}

export async function deleteRoute(id: string): Promise<void> {
  try {
    await call('DELETE', `/v3/routes/${encodeURIComponent(id)}`)
  } catch (err) {
    if (!(err instanceof MailgunError && err.status === 404)) throw err
  }
}

/** One account-wide webhook for delivery news on every domain. A second call for the same address is harmless. */
export async function ensureEventWebhook(url: string): Promise<void> {
  const fields: [string, string][] = [['url', url], ['description', 'Hell-level: delivered, bounced, spam reports, unsubscribes']]
  for (const e of ['delivered', 'permanent_fail', 'temporary_fail', 'complained', 'unsubscribed']) fields.push(['event_types', e])
  try {
    await call('POST', '/v1/webhooks', form(fields))
  } catch (err) {
    // Already there for this address.
    if (!(err instanceof MailgunError && err.status === 409)) throw err
  }
}

// ---------------------------------------------------------------------------
// Proving a post came from Mailgun
// ---------------------------------------------------------------------------

let signing: { key: string; at: number } | null = null

async function signingKey(): Promise<string> {
  if (signing && Date.now() - signing.at < 3600_000) return signing.key
  const r = await call<{ http_signing_key?: string }>('GET', '/v5/accounts/http_signing_key')
  if (!r.http_signing_key) throw new MailgunError('Mailgun didn’t return the webhook signing key', 500)
  signing = { key: r.http_signing_key, at: Date.now() }
  return signing.key
}

/**
 * HMAC-SHA256 of timestamp + token with the account's webhook signing key, as
 * Mailgun signs every post. Mailgun retries a post with the same signature,
 * so a repeat isn't refused: what the posts do is safe to do twice (replies
 * are matched by their Message-Id, delivery news just sets a status).
 */
export async function verifyMailgunSignature(s: { timestamp?: unknown; token?: unknown; signature?: unknown }): Promise<boolean> {
  const timestamp = String(s.timestamp ?? '')
  const token = String(s.token ?? '')
  const signature = String(s.signature ?? '')
  if (!timestamp || !token || !/^[0-9a-f]{64}$/i.test(signature)) return false
  // Mailgun can deliver late, but not days late.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 2 * 86_400) return false
  const expected = createHmac('sha256', await signingKey()).update(timestamp + token).digest()
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'))
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export type OutgoingEmail = {
  /** The Mailgun domain it goes out through. */
  domain: string
  from: string
  to: string
  subject: string
  text: string
  html?: string
  replyTo?: string
  headers?: Record<string, string>
  tag?: string
  /** Comes back on delivery news as user-variables. */
  vars?: Record<string, string>
}

/** Queue an email. Returns its Message-Id without the angle brackets. */
export async function sendMailgun(m: OutgoingEmail): Promise<string> {
  const fields: [string, string][] = [
    ['from', m.from],
    ['to', m.to],
    ['subject', m.subject],
    ['text', m.text],
    ['o:tracking', 'no'],
  ]
  if (m.html) fields.push(['html', m.html])
  if (m.replyTo) fields.push(['h:Reply-To', m.replyTo])
  for (const [k, v] of Object.entries(m.headers ?? {})) fields.push([`h:${k}`, v])
  if (m.tag) fields.push(['o:tag', m.tag])
  for (const [k, v] of Object.entries(m.vars ?? {})) fields.push([`v:${k}`, v])
  const r = await call<{ id?: string }>('POST', `/v3/${encodeURIComponent(m.domain)}/messages`, form(fields))
  if (!r.id) throw new MailgunError('Mailgun didn’t return a message id', 500)
  return r.id.replace(/^<|>$/g, '')
}
