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

/** Best-effort client IP extractor. NextAuth / Next.js doesn't expose
 *  one directly; we read the standard reverse-proxy headers Render
 *  forwards (`x-forwarded-for` is comma-separated, leftmost = client).
 *  Falls back to a literal "unknown" string so all anonymous requests
 *  share one bucket — worst case the legitimate user gets rate-limited
 *  alongside an attacker on the same host, which is acceptable for
 *  public-registration endpoints. */
export function clientIp(req: {
  headers: { get(name: string): string | null }
}): string {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0]?.trim()
    if (first) return first
  }
  const realIp = req.headers.get('x-real-ip')
  if (realIp) return realIp.trim()
  return 'unknown'
}
