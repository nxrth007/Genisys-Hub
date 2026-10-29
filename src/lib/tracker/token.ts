import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Signed, unguessable client status links: `<clientId>.<sig>` where sig is an
 * HMAC over the client id and a random per-client nonce stored on
 * ClientTracker.publicTokenNonce. Rotating or clearing the nonce revokes every
 * old link for that client. Pure apart from env reads; no DB.
 */

export function linkSecret(env: Record<string, string | undefined> = process.env): string | null {
  const s = (env.TRACKER_LINK_SECRET || env.AUTH_SECRET || env.NEXTAUTH_SECRET || '').trim()
  return s.length >= 16 ? s : null
}

export function newNonce(): string {
  return randomBytes(18).toString('base64url')
}

const sig = (clientId: string, nonce: string, secret: string) =>
  createHmac('sha256', secret).update(`tracker-status:${clientId}:${nonce}`).digest('base64url').slice(0, 32)

export function signStatusToken(clientId: string, nonce: string, secret: string): string {
  if (!clientId || !nonce || !secret) throw new Error('clientId, nonce and secret are required')
  if (clientId.includes('.')) throw new Error('invalid clientId')
  return `${clientId}.${sig(clientId, nonce, secret)}`
}

/** Split a token into its client id (to look the nonce up) without trusting it. */
export function tokenClientId(token: string): string | null {
  const m = /^([A-Za-z0-9_-]{8,64})\.([A-Za-z0-9_-]{32})$/.exec(token ?? '')
  return m ? m[1] : null
}

export function verifyStatusToken(token: string, nonce: string | null | undefined, secret: string | null): boolean {
  const clientId = tokenClientId(token)
  if (!clientId || !nonce || !secret) return false
  const expected = Buffer.from(signStatusToken(clientId, nonce, secret))
  const given = Buffer.from(token)
  return expected.length === given.length && timingSafeEqual(expected, given)
}
