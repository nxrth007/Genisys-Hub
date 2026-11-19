/**
 * Lightweight in-memory rate limiter.
 *
 * Keyed by an arbitrary string (caller passes IP, email, etc.) so the
 * same module backs IP-based and identity-based limits. Backed by a
 * Map of fixed-size sliding-windows per key — old timestamps fall off
 * automatically as the window advances.
 *
 * Why in-memory: Render's hobby/starter plans run a single Node
 * process per service, so per-process state effectively maps 1:1 to
 * "per server". Not bulletproof against a distributed attacker (no
 * IP coordination across replicas), but a meaningful deterrent
 * against accidental floods + naive abuse, which is the realistic
 * threat model here. Swap for Upstash / Postgres-backed if we ever
 * scale out horizontally.
 *
 * Memory is bounded: we lazily prune expired entries on every check,
 * and the Map's keys are small (an IP-and-bucket string). Worst-case
 * a single attacker could try to flood unique keys, but that scales
 * O(rate * windowMs) which is by definition limited by the window.
 */
type WindowEntry = number[]

const buckets = new Map<string, WindowEntry>()

/** Result of a rate-limit check. `ok=true` means proceed; `ok=false`
 *  means deny. `retryAfterMs` is populated on deny so the caller can
 *  surface a friendly Retry-After hint to the client. */
export type RateLimitResult =
  | { ok: true; remaining: number }
  | { ok: false; retryAfterMs: number }

/** Try to consume one slot in a sliding window for `key`. Returns
 *  ok=true if under the limit, ok=false (with retryAfterMs) when over.
 *  Each successful call counts toward the limit. */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now()
  const cutoff = now - windowMs
  const existing = buckets.get(key) ?? []
  // Prune entries that fell out of the window.
  const recent = existing.filter((t) => t > cutoff)
  if (recent.length >= limit) {
    const oldest = recent[0]!
    const retryAfterMs = Math.max(0, oldest + windowMs - now)
    // Persist the pruned (still-active) window so future calls don't
    // re-check expired entries.
    buckets.set(key, recent)
    return { ok: false, retryAfterMs }
  }
  recent.push(now)
  buckets.set(key, recent)
  return { ok: true, remaining: limit - recent.length }
}

function oneIp(value: string | null | undefined): string | null {
  const t = (value ?? '').trim()
  if (!t || t.length > 45 || /[\s,]/.test(t)) return null
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) {
    const parts = t.split('.').map((n) => Number(n))
    if (parts.some((n) => n > 255)) return null
    return t
  }
  if (/^[0-9a-f:]+$/i.test(t) && t.includes(':')) return t
  return null
}

/**
 * Visitor address on Render.
 *
 * Render's edge is Cloudflare, then Render's own proxy. Cloudflare sets
 * CF-Connecting-IP to the visitor and overwrites a client-supplied value,
 * and Render forwards that header. A spoofed X-Forwarded-For prefix cannot
 * override it.
 *
 * When that header is absent, the first X-Forwarded-For address is the
 * visitor. Render sets that entry to the real client. The last address is
 * the latest proxy (often Cloudflare or Render's balancer), so it is not
 * the cardholder and is not used.
 */
export function clientIp(req: {
  headers: { get(name: string): string | null }
}): string {
  const cf = oneIp(req.headers.get('cf-connecting-ip'))
  if (cf) return cf
  const trusted = oneIp(req.headers.get('true-client-ip'))
  if (trusted) return trusted
  const xff = req.headers.get('x-forwarded-for')
  if (xff) {
    for (const part of xff.split(',')) {
      const ip = oneIp(part)
      if (ip) return ip
    }
  }
  return oneIp(req.headers.get('x-real-ip')) ?? 'unknown'
}
