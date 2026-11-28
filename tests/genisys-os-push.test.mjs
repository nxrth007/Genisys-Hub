import assert from 'node:assert/strict'
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

// Genisys OS notifications (src/lib/hl/push-crypto.ts): Web Push written by hand, so it's held to
// the standard's own worked example, byte for byte.

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function loadTs(absPath) {
  const { outputText } = ts.transpileModule(readFileSync(absPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const m = { exports: {} }
  new Function('module', 'exports', 'require', outputText)(m, m.exports, createRequire(pathToFileURL(absPath)))
  return m.exports
}

const push = loadTs(join(root, 'src/lib/hl/push-crypto.ts'))
const b = (s) => Buffer.from(s, 'base64url')

// RFC 8291, Appendix A ("Intermediate Values for Encryption"), wrapped values joined.
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
}

/** The phone's side (RFC 8291 §3.4 and RFC 8188 run backwards): open a message with the browser's private key. */
function decrypt(body, uaPrivate, uaPublic, authSecret) {
  const salt = body.subarray(0, 16)
  const rs = body.readUInt32BE(16)
  const idlen = body[20]
  const asPublic = body.subarray(21, 21 + idlen)
  const record = body.subarray(21 + idlen)
  assert.equal(rs, 4096)
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(uaPrivate)
  const secret = ecdh.computeSecret(asPublic)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', secret, authSecret, keyInfo, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(record.subarray(record.length - 16))
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()])
  assert.equal(padded[padded.length - 1], 2, 'a single record ends with the 0x02 delimiter')
  return padded.subarray(0, padded.length - 1)
}

test('encryption reproduces RFC 8291’s worked example exactly', () => {
  assert.equal(b(RFC.plaintext).toString(), 'When I grow up, I want to be a watermelon')
  const body = push.encryptPayload(b(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.authSecret }, { salt: b(RFC.salt), serverPrivateKey: b(RFC.asPrivate) })
  assert.equal(body.subarray(0, 86).toString('base64url'), RFC.header, 'the 86-byte header: salt, record size 4096, the server key')
  assert.equal(body.subarray(86).toString('base64url'), RFC.ciphertext, 'the encrypted record')
})

test('a real send (random salt, one-time key) opens with the phone’s key and nothing else', () => {
  const phone = createECDH('prime256v1')
  phone.generateKeys()
  const auth = Buffer.from('0123456789abcdef')
  const message = Buffer.from(JSON.stringify({ title: 'Maria Gonzalez', body: 'Can you come Tuesday?' }))
  const sub = { p256dh: phone.getPublicKey().toString('base64url'), auth: auth.toString('base64url') }
  const one = push.encryptPayload(message, sub)
  const two = push.encryptPayload(message, sub)
  assert.notEqual(one.toString('base64'), two.toString('base64'), 'every send is encrypted afresh')
  assert.equal(decrypt(one, phone.getPrivateKey(), phone.getPublicKey(), auth).toString(), message.toString())
  const stranger = createECDH('prime256v1')
  stranger.generateKeys()
  assert.throws(() => decrypt(one, stranger.getPrivateKey(), phone.getPublicKey(), auth))
})

test('the RFC example also opens on the phone’s side (the decrypt above is sound)', () => {
  const body = Buffer.concat([b(RFC.header), b(RFC.ciphertext)])
  assert.equal(decrypt(body, b(RFC.uaPrivate), b(RFC.uaPublic), b(RFC.authSecret)).toString(), 'When I grow up, I want to be a watermelon')
})

test('too big for one push is refused; bad subscription keys are refused', () => {
  const phone = createECDH('prime256v1')
  phone.generateKeys()
  const sub = { p256dh: phone.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') }
  assert.throws(() => push.encryptPayload(Buffer.alloc(push.MAX_PAYLOAD + 1), sub), /can carry/)
  assert.ok(push.encryptPayload(Buffer.alloc(push.MAX_PAYLOAD), sub).length <= 4096, 'the largest allowed message still fits in 4096 bytes')
  assert.throws(() => push.encryptPayload(Buffer.from('x'), { ...sub, auth: 'c2hvcnQ' }), /auth secret/)
  assert.equal(push.subscriptionKeysOk(sub.p256dh, sub.auth), true)
  assert.equal(push.subscriptionKeysOk(sub.p256dh.slice(4), sub.auth), false)
})

test('VAPID: a JWT for the push service’s origin, 12 hours, signed with the Hub’s key (ES256)', () => {
  const keys = push.newVapidKeys()
  assert.equal(Buffer.from(keys.publicKey, 'base64url').length, 65)
  assert.equal(Buffer.from(keys.privateKey, 'base64url').length, 32)
  const now = Date.UTC(2026, 10, 28, 12, 0, 0)
  const header = push.vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc:def', keys, 'https://genisys-hub.onrender.com', now)
  const m = header.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/)
  assert.ok(m, header)
  const [, h, c, s, k] = m
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { typ: 'JWT', alg: 'ES256' })
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url')), { aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'https://genisys-hub.onrender.com' })
  assert.equal(k, keys.publicKey)
  const pub = Buffer.from(k, 'base64url')
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' })
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), 'the signature checks out')
})

test('only the browser push services are ever posted to', () => {
  const ok = [
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://web.push.apple.com/QGk2y',
    'https://api.push.apple.com/3/device/x',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
    'https://wns2-by3p.notify.windows.com/w/?token=x',
  ]
  const no = [
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com:8443/fcm/send/abc',
    'https://fcm.googleapis.com.evil.example/x',
    'https://evilpush.apple.com.example/x',
    'https://user:pw@fcm.googleapis.com/x',
    'https://localhost/x',
    'http://169.254.169.254/latest/meta-data',
    'https://genisys-hub.onrender.com/api/hl/push',
    'not a url',
  ]
  for (const u of ok) assert.equal(push.pushEndpointAllowed(u), true, u)
  for (const u of no) assert.equal(push.pushEndpointAllowed(u), false, u)
  // A local receiver only when a local check asks for it, and never anything else that way.
  assert.equal(push.pushEndpointAllowed('http://localhost:51399/push/1'), false)
  assert.equal(push.pushEndpointAllowed('http://localhost:51399/push/1', { localTest: true }), true)
  assert.equal(push.pushEndpointAllowed('http://10.0.0.5/push/1', { localTest: true }), false)
})

test('the notification: who, what they said, and a tap opens their conversation', () => {
  const contact = { id: 'c1', firstName: 'Maria', lastName: 'Gonzalez', phone: '+15125550111', email: null }
  const sms = push.inboxNotification({ accountId: 'a1', contact, kind: 'sms', text: 'Can you come\nTuesday?', unread: 3 })
  assert.deepEqual(sms, { title: 'Maria Gonzalez', body: 'Can you come Tuesday?', url: '/genisys-os/a1/conversations?contact=c1', tag: 'gos-c1', unread: 3 })
  const stranger = { id: 'c2', firstName: null, lastName: null, phone: '+15125550112', email: null }
  assert.equal(push.inboxNotification({ accountId: 'a1', contact: stranger, kind: 'missed_call', text: 'Missed call' }).title, '(512) 555-0112')
  assert.equal(push.inboxNotification({ accountId: 'a1', contact: stranger, kind: 'missed_call', text: 'Missed call' }).body, 'Missed call')
  assert.equal(push.inboxNotification({ accountId: 'a1', contact: stranger, kind: 'sms', text: '' }).body, 'Sent a photo')
  const form = push.inboxNotification({ accountId: 'a1', contact, kind: 'activity', text: 'Website Quote Form\nService: Roof leak\nMessage: Water stain on the ceiling\nPhone: 512' })
  assert.equal(form.body, 'Website Quote Form · Service: Roof leak · Message: Water stain on the ceiling')
  const long = push.inboxNotification({ accountId: 'a1', contact, kind: 'sms', text: 'x'.repeat(500) })
  assert.equal(long.body.length, 180)
  assert.ok(long.body.endsWith('…'))
  assert.ok(Buffer.byteLength(JSON.stringify(long)) < push.MAX_PAYLOAD)
})
