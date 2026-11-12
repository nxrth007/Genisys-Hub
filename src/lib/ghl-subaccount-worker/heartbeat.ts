/** How often a live run proves it is still the process holding the job. */
export const HEARTBEAT_INTERVAL_MS = 20_000

/** A running job with no heartbeat for this long was abandoned. */
export const HEARTBEAT_STALE_MS = 3 * 60 * 1000

/** A single browser attempt must finish or be failed by this point. */
export const JOB_WALL_MS = 20 * 60 * 1000

export const ABANDONED_JOB_LOG = 'Recovered a job abandoned by a restarted instance'

/**
 * Fresh heartbeats win. A row claimed before heartbeats existed falls
 * back to updatedAt, so an orphan with neither stamp is stale.
 */
export function isHeartbeatStale(
  heartbeatAt: Date | string | null | undefined,
  updatedAt: Date | string | null | undefined,
  now = Date.now(),
): boolean {
  const stamp = heartbeatAt ?? updatedAt
  if (!stamp) return true
  const at = new Date(stamp).getTime()
  if (Number.isNaN(at)) return true
  return now - at > HEARTBEAT_STALE_MS
}

/** Dry-run boots requeue a needs_human or dry_run job whose form name starts with Test:. */
export function shouldAutoRetest(mode: string, status: string, name: string): boolean {
  return mode !== 'create' && (status === 'needs_human' || status === 'dry_run') && name.startsWith('Test:')
}
