/**
 * Shared cache for the staff-bookings read.
 *
 * Lives outside the route module so the attendance write can invalidate
 * it. Without that, marking someone as showed would appear to do nothing
 * for up to a minute — the read would keep serving the pre-write answer,
 * which reads as a broken control rather than a stale cache.
 */

const CACHE_MS = 60_000

const store = new Map<string, { at: number; data: unknown }>()

export function readCache(key: string): unknown | null {
  const hit = store.get(key)
  if (!hit) return null
  if (Date.now() - hit.at >= CACHE_MS) {
    store.delete(key)
    return null
  }
  return hit.data
}

export function writeCache(key: string, data: unknown): void {
  store.set(key, { at: Date.now(), data })
}

/** Called after any write that changes what the read would return. */
export function clearStaffBookingsCache(): void {
  store.clear()
}
