import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto'

/**
 * Web Push without a package: the VAPID signature that tells the push service the Hub sent it
 * (RFC 8292) and the encryption only the subscribed phone can open (RFC 8291, "aes128gcm" from
 * RFC 8188). Google, Apple, Mozilla and Microsoft relay the message but can't read it.
 *
 * Pure (no database, no network): src/lib/hl/push.ts stores the keys and sends. Checked byte for
 * byte against RFC 8291's worked example in tests/genisys-os-push.test.mjs.
 */

export const b64url = (b: Uint8Array): string => Buffer.from(b).toString('base64url')
export const fromB64url = (s: string): Buffer => Buffer.from(s, 'base64url')

/** P-256, base64url: the 65-byte uncompressed public point and the 32-byte private scalar. */
export type VapidKeys = { publicKey: string; privateKey: string }

/** A P-256 private key is 32 bytes; one with leading zero bytes can come back shorter. */
const pad32 = (b: Buffer): Buffer => (b.length >= 32 ? b : Buffer.concat([Buffer.alloc(32 - b.length), b]))

export function newVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(pad32(ecdh.getPrivateKey())) }
}

function signingKey(keys: VapidKeys) {
  const pub = fromB64url(keys.publicKey)
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('The push public key isn’t an uncompressed P-256 point.')
  return createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33)), d: b64url(pad32(fromB64url(keys.privateKey))) },
    format: 'jwk',
  })
}

/**
 * The Authorization header for one push: a JWT for the push service's origin, good for 12 hours
 * (the limit is 24), signed with the Hub's key; `subject` is how the service can reach the sender.
 */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64url(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })))
  const unsigned = `${header}.${claims}`
  const signature = sign('sha256', Buffer.from(unsigned), { key: signingKey(keys), dsaEncoding: 'ieee-p1363' })
  return `vapid t=${unsigned}.${b64url(signature)}, k=${keys.publicKey}`
}

/** One record of this size holds the whole message; push services take 4096-byte bodies at most. */
const RECORD_SIZE = 4096
/** What fits: the record, less the 16-byte tag and the 0x02 delimiter, inside 4096 less the 86-byte header. */
export const MAX_PAYLOAD = 4096 - 86 - 16 - 1

/**
 * The message, encrypted to the browser's keys (its p256dh and auth from the subscription). `salt`
 * and `serverPrivateKey` are only ever given by the test, to reproduce RFC 8291's example; a real
 * send uses a fresh random salt and a one-time key pair.
 */
export function encryptPayload(plaintext: Uint8Array, to: { p256dh: string; auth: string }, o: { salt?: Uint8Array; serverPrivateKey?: Uint8Array } = {}): Buffer {
  if (plaintext.length > MAX_PAYLOAD) throw new Error(`A push message can carry ${MAX_PAYLOAD} bytes; this one is ${plaintext.length}.`)
  const uaPublic = fromB64url(to.p256dh)
  const authSecret = fromB64url(to.auth)
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('The subscription’s p256dh key isn’t an uncompressed P-256 point.')
  if (authSecret.length !== 16) throw new Error('The subscription’s auth secret isn’t 16 bytes.')

  const server = createECDH('prime256v1')
  if (o.serverPrivateKey) server.setPrivateKey(Buffer.from(o.serverPrivateKey))
  else server.generateKeys()
  const asPublic = server.getPublicKey()
  const ecdhSecret = server.computeSecret(uaPublic)

  // RFC 8291 §3.4: the auth secret and both public keys go into the key, then RFC 8188 derives the content key and nonce.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32))
  const salt = Buffer.from(o.salt ?? randomBytes(16))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12))

  // A single (so last) record: the message, then the 0x02 delimiter, no padding.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const record = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])

  // The header: salt, record size, and the one-time public key the browser needs to derive the same secret.
  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header.writeUInt8(asPublic.length, 20)
  return Buffer.concat([header, asPublic, record])
}

/**
 * The browser push services, and only those, get messages from the Hub. A subscription is sent in by
 * the browser, so without this check anyone signed in could make the Hub post to any address
 * (an internal service, say). `localTest` lets a local check point at a receiver on this machine.
 */
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'web.push.apple.com']
const PUSH_HOST_ENDINGS = ['.push.apple.com', '.notify.windows.com', '.push.services.mozilla.com']

export function pushEndpointAllowed(endpoint: string, o: { localTest?: boolean } = {}): boolean {
  let u: URL
  try {
    u = new URL(endpoint)
  } catch {
    return false
  }
  if (u.username || u.password) return false
  if (o.localTest && u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true
  if (u.protocol !== 'https:' || u.port) return false
  const host = u.hostname.toLowerCase()
  return PUSH_HOSTS.includes(host) || PUSH_HOST_ENDINGS.some((end) => host.endsWith(end))
}

/** A subscription's keys as browsers make them: a P-256 point and a 16-byte secret. */
export function subscriptionKeysOk(p256dh: string, auth: string): boolean {
  const pub = fromB64url(p256dh)
  return pub.length === 65 && pub[0] === 4 && fromB64url(auth).length === 16
}

// ---------------------------------------------------------------------------
// What the notification says
// ---------------------------------------------------------------------------

/** What made the conversation unread: a text, an email, a form / chat / booking line, or a missed call. */
export type InboxKind = 'sms' | 'email' | 'activity' | 'missed_call'

export type InboxNotification = { title: string; body: string; url: string; tag: string; unread?: number }

const pretty = (phone: string) => {
  const d = phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : phone
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

/**
 * The lock-screen notification: who (their name, else their number), what (the text itself, the
 * form's first lines, "Missed call"), and where a tap goes (their conversation). One per
 * conversation at a time: a second text from the same lead replaces the first (tag).
 */
export function inboxNotification(o: {
  accountId: string
  contact: { id: string; firstName: string | null; lastName: string | null; phone: string | null; email: string | null }
  kind: InboxKind
  text: string
  unread?: number
}): InboxNotification {
  const c = o.contact
  const name = [c.firstName, c.lastName].filter((s) => s?.trim()).join(' ').trim()
  const title = name || (c.phone ? pretty(c.phone) : '') || c.email || 'New lead'
  const lines = o.text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const said =
    o.kind === 'missed_call'
      ? 'Missed call'
      : o.kind === 'activity'
        ? lines.slice(0, 3).join(' · ')
        : lines.join(' ') || (o.kind === 'sms' ? 'Sent a photo' : 'New message')
  return {
    title: clip(title, 60),
    body: clip(said || 'New activity', 180),
    url: `/genisys-os/${o.accountId}/conversations?contact=${c.id}`,
    tag: `gos-${c.id}`,
    ...(typeof o.unread === 'number' ? { unread: o.unread } : {}),
  }
}
