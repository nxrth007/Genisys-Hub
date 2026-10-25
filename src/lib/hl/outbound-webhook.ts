import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { HlProfile, HlStep } from './types'

/**
 * The Webhook action: a workflow sending a request to another app, as GHL's
 * Webhook (the contact's details plus "custom data") and Custom Webhook (any
 * method, headers, query parameters, auth and a body written in the step)
 * do. Every part takes merge fields; in a JSON body they're escaped so a
 * quote in someone's name can't break it.
 *
 * Requests only go to public addresses: a step can't reach the Hub's own
 * network (localhost, private ranges, the cloud metadata address), checked
 * again on every redirect. Requests time out after 15 seconds and only the
 * first 256 KB of an answer is read. The engine retries a failed request
 * twice (5xx, 429, no answer) and then carries on.
 */

export type WebhookResult = {
  ok: boolean
  status: number | null
  ms: number
  /** One line for the run log: method, address, status. Never headers or the body. */
  detail: string
  /** The answer, parsed when it's JSON. */
  data?: unknown
  /** Worth trying again (the other app is down or busy, or didn't answer). */
  retry: boolean
}

export type BuiltRequest = { method: string; url: string; headers: Record<string, string>; body?: string }

class WebhookError extends Error {}

const TIMEOUT_MS = 15_000
const MAX_RESPONSE = 256_000
const MAX_REDIRECTS = 3

/** Swapped in tests: the network calls this module makes. */
export const outboundHooks = {
  fetch: (url: string, init: RequestInit) => fetch(url, init),
  lookup: (host: string) => lookup(host, { all: true }),
}

/** An IPv6 address as its eight 16-bit groups (a dotted IPv4 tail included), or null. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0]
  const dotted = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number)
    s = `${s.slice(0, -dotted[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null
  const groups = tail === null ? head : [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail]
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null
  return groups.map((g) => parseInt(g, 16))
}

const v4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`

/** Local and private addresses: the Hub's own network, link-local (cloud metadata), multicast; IPv4 inside IPv6 too. */
export function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
  }
  const g = v6Groups(ip)
  if (!g) return true
  // ::, ::1, and IPv4 written as IPv6 (::ffff:a.b.c.d, ::a.b.c.d): judged as the IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0 || g[5] === 0xffff)) {
    if (g[5] === 0 && g[6] === 0 && g[7] <= 1) return true
    return privateAddress(v4Of(g[6], g[7]))
  }
  // NAT64 (64:ff9b::a.b.c.d) and 6to4 (2002:aabb:ccdd::) carry an IPv4 address too.
  if (g[0] === 0x64 && g[1] === 0xff9b) return privateAddress(v4Of(g[6], g[7]))
  if (g[0] === 0x2002) return privateAddress(v4Of(g[1], g[2]))
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00
}

/** An address a step may call: http(s), and a host that's on the public internet. */
export async function checkUrl(raw: string): Promise<URL> {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new WebhookError(`“${raw.slice(0, 80) || '(blank)'}” isn’t a full web address (it needs https://…)`)
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new WebhookError('Webhooks go to http(s) addresses only')
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const local = 'Webhooks can’t go to local or internal addresses'
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home)$/.test(host)) throw new WebhookError(local)
  const addresses = isIP(host)
    ? [host]
    : await outboundHooks
        .lookup(host)
        .then((r) => r.map((x) => x.address))
        .catch(() => {
          throw new WebhookError(`Couldn’t find ${host}`)
        })
  if (!addresses.length || addresses.some(privateAddress)) throw new WebhookError(local)
  return u
}

/** Merge fields in a JSON body, escaped for inside a JSON string. */
function renderJson(text: string, render: (s: string) => string): string {
  return text.replace(/\{\{\s*[^{}]+?\s*\}\}/g, (token) => JSON.stringify(render(token)).slice(1, -1))
}

const pairs = (list: { key: string; value: string }[] | undefined, render: (s: string) => string) =>
  (list ?? []).map((p) => [render(p.key).trim(), render(p.value)] as const).filter(([k]) => k)

/** The request a step makes. `payload` builds the contact's details when the step sends them. */
export function buildRequest(cfg: HlStep['config'], render: (s: string) => string, payload: () => Record<string, unknown>): BuiltRequest {
  const method = (cfg.method ?? 'POST').toUpperCase()
  const target = render(cfg.url ?? '').trim()
  let url: URL
  try {
    url = new URL(target)
  } catch {
    throw new WebhookError(`“${target.slice(0, 80) || '(blank)'}” isn’t a full web address (it needs https://…)`)
  }
  for (const [k, v] of pairs(cfg.params, render)) url.searchParams.append(k, v)
  const headers: Record<string, string> = { 'user-agent': 'Hell-level webhook (Genisys Hub)' }
  for (const [k, v] of pairs(cfg.headers, render)) headers[k.toLowerCase()] = v
  const auth = cfg.auth
  if (auth?.type === 'basic') headers.authorization = `Basic ${Buffer.from(`${render(auth.username ?? '')}:${render(auth.password ?? '')}`).toString('base64')}`
  if (auth?.type === 'bearer') headers.authorization = `Bearer ${render(auth.token ?? '').trim()}`
  if (auth?.type === 'api_key' && auth.key?.trim()) {
    if (auth.in === 'query') url.searchParams.set(auth.key.trim(), render(auth.value ?? ''))
    else headers[auth.key.trim().toLowerCase()] = render(auth.value ?? '')
  }
  // A GET carries no body; a DELETE only one written for it.
  const kind = method === 'GET' ? 'none' : method === 'DELETE' ? (cfg.bodyType === 'raw' || cfg.bodyType === 'form' ? cfg.bodyType : 'none') : (cfg.bodyType ?? 'contact')
  let body: string | undefined
  if (kind === 'contact') {
    body = JSON.stringify(payload())
    headers['content-type'] ??= 'application/json'
  } else if (kind === 'raw') {
    const type = cfg.contentType?.trim() || 'application/json'
    body = /json/i.test(type) ? renderJson(cfg.rawBody ?? '', render) : render(cfg.rawBody ?? '')
    headers['content-type'] ??= type
  } else if (kind === 'form') {
    body = new URLSearchParams(pairs(cfg.data, render) as [string, string][]).toString()
    headers['content-type'] ??= 'application/x-www-form-urlencoded'
  }
  return { method, url: url.toString(), headers, body }
}

type PayloadContact = { id: string; firstName?: string | null; lastName?: string | null; email?: string | null; phone?: string | null; tags?: string[]; source?: string | null; createdAt?: Date | string; fields?: unknown }

/** The contact's details as GHL's Webhook action sends them, with the step's custom data. */
export function contactPayload(o: {
  contact: PayloadContact
  accountId: string
  profile: HlProfile
  workflow: { id: string; name: string }
  trigger: Record<string, unknown>
  custom: Record<string, string>
}): Record<string, unknown> {
  const c = o.contact
  const fields = c.fields && typeof c.fields === 'object' && !Array.isArray(c.fields) ? (c.fields as Record<string, unknown>) : {}
  return {
    ...fields,
    contact_id: c.id,
    first_name: c.firstName ?? '',
    last_name: c.lastName ?? '',
    full_name: [c.firstName, c.lastName].filter(Boolean).join(' '),
    email: c.email ?? '',
    phone: c.phone ?? '',
    tags: (c.tags ?? []).join(','),
    contact_source: c.source ?? '',
    date_created: c.createdAt ? new Date(c.createdAt).toISOString() : null,
    location: { id: o.accountId, name: o.profile.businessName ?? '', phone: o.profile.businessPhone ?? '', website: o.profile.website ?? '', address: o.profile.address ?? '' },
    workflow: o.workflow,
    triggerData: o.trigger,
    customData: o.custom,
  }
}

/** "hooks.zapier.com/hooks/catch/123…" for the log: no query, which can hold keys. */
function shortUrl(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname.length > 32 ? `${u.pathname.slice(0, 31)}…` : u.pathname
    return `${u.host}${path === '/' ? '' : path}`
  } catch {
    return url.slice(0, 40)
  }
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < MAX_RESPONSE) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.byteLength
  }
  await reader.cancel().catch(() => undefined)
  const all = new Uint8Array(Math.min(size, MAX_RESPONSE))
  let at = 0
  for (const c of chunks) {
    const part = c.subarray(0, Math.max(0, all.length - at))
    all.set(part, at)
    at += part.length
  }
  return new TextDecoder().decode(all)
}

function parsed(text: string, type: string | null): unknown {
  if (!text.trim()) return null
  if (/json/i.test(type ?? '') || /^\s*[[{]/.test(text)) {
    try {
      return JSON.parse(text)
    } catch {
      // not JSON after all
    }
  }
  return text
}

const snippet = (text: string) => {
  const s = text.replace(/\s+/g, ' ').trim()
  return s ? `: ${s.length > 120 ? `${s.slice(0, 117)}…` : s}` : ''
}

/** Send it (following up to 3 redirects, each checked), and say how it went. */
export async function sendWebhook(req: BuiltRequest): Promise<WebhookResult> {
  const started = Date.now()
  let { method, url, body } = req
  const host = () => shortUrl(url)
  try {
    for (let hop = 0; ; hop++) {
      await checkUrl(url)
      const res = await outboundHooks.fetch(url, { method, headers: req.headers, body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) })
      const location = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && location && hop < MAX_REDIRECTS) {
        url = new URL(location, url).toString()
        // As browsers do: a 303, or a 301/302 after a POST, carries on as a GET.
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          method = 'GET'
          body = undefined
        }
        continue
      }
      const text = await readCapped(res)
      const ok = res.status < 400
      return {
        ok,
        status: res.status,
        ms: Date.now() - started,
        detail: `${method} ${host()} → ${res.status}${ok ? '' : snippet(text)}`,
        data: parsed(text, res.headers.get('content-type')),
        retry: res.status >= 500 || res.status === 429,
      }
    }
  } catch (err) {
    if (err instanceof WebhookError) return { ok: false, status: null, ms: Date.now() - started, detail: err.message, retry: false }
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    const why = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err)
    return { ok: false, status: null, ms: Date.now() - started, detail: timedOut ? `No answer from ${host()} in 15 seconds` : `Couldn’t reach ${host()} (${why})`, retry: true }
  }
}

/** Build and send in one go; a step that can't be built is a failure that isn't retried. */
export async function callWebhook(cfg: HlStep['config'], render: (s: string) => string, payload: () => Record<string, unknown>): Promise<WebhookResult> {
  let req: BuiltRequest
  try {
    req = buildRequest(cfg, render, payload)
  } catch (err) {
    return { ok: false, status: null, ms: 0, detail: err instanceof Error ? err.message : String(err), retry: false }
  }
  return sendWebhook(req)
}

/** A response as kept on a run: whole up to 32 KB, else its top-level plain values. */
export function keptResponse(data: unknown): unknown {
  const text = JSON.stringify(data) ?? 'null'
  if (text.length <= 32_000) return data
  if (typeof data === 'string') return data.slice(0, 32_000)
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  return Object.fromEntries(Object.entries(data as Record<string, unknown>).filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v)))
}

/** A made-up lead for test requests from the builder. */
export const SAMPLE_CONTACT: PayloadContact = {
  id: 'sample-contact',
  firstName: 'Jennifer',
  lastName: 'Smith',
  email: 'jennifer@example.com',
  phone: '+15125550123',
  tags: ['sample'],
  source: 'form',
  createdAt: new Date('2026-10-25T15:00:00Z'),
  fields: { service: 'Roof repair', message: 'Small leak over the kitchen' },
}
