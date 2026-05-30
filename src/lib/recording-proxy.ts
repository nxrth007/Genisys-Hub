/**
 * Call-recording proxy — turns IP-whitelisted vicitel recording URLs
 * into signed Hub URLs that anyone can play.
 *
 * Problem: our call-center provider (Vicitel) gates raw recording
 * MP3 URLs behind IP allowlists. Alex's home IP is on the list; our
 * clients' IPs are not, so when Mary books an appointment and the
 * Hub posts the recording link in the client's Slack channel, the
 * client can't actually listen — they get a 403 from vicitel.
 *
 * Solution: the Hub itself is on vicitel's allowlist (after a one-
 * time infra step), so we can fetch the original MP3 from a server
 * route and stream it back to whoever requested it. The recording
 * link we put in messages becomes:
 *
 *     <hub-origin>/api/recordings/proxy?u=<base64(originalUrl)>&s=<hmac>
 *
 * The HMAC signature prevents URL enumeration: anyone with a valid
 * proxy URL can play that one recording, but nobody can construct a
 * URL for an arbitrary vicitel path without the secret. Same security
 * model as S3 pre-signed URLs.
 *
 * Trade-offs vs. downloading + storing:
 *   - Pure proxy adds zero storage cost. Every playback hits vicitel
 *     fresh, which is fine for our volume (handful of plays per
 *     appointment, mostly within hours of booking).
 *   - If vicitel ever goes offline / archives old recordings, the
 *     proxied link breaks. Acceptable risk; can be upgraded to
 *     "also save to Drive on first delivery" later without rework.
 */
import crypto from 'crypto'

const ENV_SECRET = 'RECORDING_PROXY_SECRET'
const ENV_ALLOWED_HOSTS = 'RECORDING_PROXY_ALLOWED_HOSTS'

/** Default allowlist when RECORDING_PROXY_ALLOWED_HOSTS isn't set.
 *  Only proxy recordings from our actual provider — guards against
 *  someone with the secret using the proxy as a generic SSRF gadget.
 *  Extend via env var (comma-separated hostnames) when we onboard
 *  another call-center vendor. */
const DEFAULT_ALLOWED_HOSTS = ['expeditusbpo.vicitel.cc']

/**
 * Wrap a recording URL with the proxy. When RECORDING_PROXY_SECRET
 * isn't set yet (pre-rollout), returns null — callers should treat
 * that as "skip the recording line entirely" rather than ship the
 * unsigned vicitel URL to a client who can't play it.
 */
export function signRecordingUrl(
  originalUrl: string,
  hubOrigin: string,
): string | null {
  const secret = process.env[ENV_SECRET]
  if (!secret) return null
  if (!isAllowedHost(originalUrl)) return null

  const u = Buffer.from(originalUrl, 'utf-8').toString('base64url')
  const sig = crypto
    .createHmac('sha256', secret)
    .update(originalUrl)
    .digest('base64url')

  const origin = hubOrigin.replace(/\/$/, '')
  return `${origin}/api/recordings/proxy?u=${u}&s=${sig}`
}

/**
 * Verify a (u, s) pair came from us. Returns the decoded original
 * URL when the signature checks out, null otherwise. Constant-time
 * comparison so an attacker can't time-leak the secret. Length
 * mismatches return null without comparing (timingSafeEqual throws
 * on mismatched buffer sizes, which would leak length).
 */
export function verifyAndDecodeRecordingUrl(
  u: string,
  s: string,
): string | null {
  const secret = process.env[ENV_SECRET]
  if (!secret) return null
  if (!u || !s) return null

  let originalUrl: string
  try {
    originalUrl = Buffer.from(u, 'base64url').toString('utf-8')
  } catch {
    return null
  }
  if (!isAllowedHost(originalUrl)) return null

  const expected = crypto
    .createHmac('sha256', secret)
    .update(originalUrl)
    .digest('base64url')
  const expectedBuf = Buffer.from(expected, 'utf-8')
  const providedBuf = Buffer.from(s, 'utf-8')
  if (expectedBuf.length !== providedBuf.length) return null
  if (!crypto.timingSafeEqual(expectedBuf, providedBuf)) return null

  return originalUrl
}

/** Lowercase exact-match hostname check against the allowlist.
 *  We deliberately do NOT support wildcards / suffix matching to keep
 *  the security boundary obvious — every new host has to be added
 *  intentionally. */
function isAllowedHost(rawUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  const envList = process.env[ENV_ALLOWED_HOSTS]
  const allowed = envList
    ? envList.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_ALLOWED_HOSTS
  return allowed.includes(parsed.hostname.toLowerCase())
}

/** True when the proxy is fully configured (secret set + at least
 *  one allowed host). Used by the format helpers to decide whether
 *  to include the Listen link at all — better to omit than to ship
 *  a link that won't work. */
export function isRecordingProxyConfigured(): boolean {
  return !!process.env[ENV_SECRET]
}
