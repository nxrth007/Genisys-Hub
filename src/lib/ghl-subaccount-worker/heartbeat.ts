/** How often a live run proves it is still the process holding the job. */
export const HEARTBEAT_INTERVAL_MS = 20_000

/** A running job with no heartbeat for this long was abandoned. */
export const HEARTBEAT_STALE_MS = 3 * 60 * 1000

/** A single browser attempt must finish or be failed by this point. */
export const JOB_WALL_MS = 20 * 60 * 1000

export const ABANDONED_JOB_LOG = 'Recovered a job abandoned by a restarted instance'

/** Wait out the previous instance before requeueing a dry-run retest. */
export const AUTO_RETEST_DELAY_MS = 90_000

/** Short SHA Render injects, matching /api/health. "local" off Render. */
export function runningCommit(env: NodeJS.ProcessEnv = process.env): string {
  const sha = env.RENDER_GIT_COMMIT?.trim() || ''
  return sha ? sha.slice(0, 7) : 'local'
}

/** Prefix a job log line so the build that wrote it is visible. */
export function stampJobLog(msg: string, commit = runningCommit()): string {
  const tag = `[${commit}]`
  return msg.startsWith(`${tag} `) ? msg : `${tag} ${msg}`
}

export function jobLogEntry(msg: string, at: Date = new Date(), commit = runningCommit()): { at: string; msg: string } {
  return { at: at.toISOString(), msg: stampJobLog(msg, commit).slice(0, 4000) }
}

/** True once this process has been up long enough that the retiring instance should be gone. */
export function autoRetestDue(bootedAtMs: number, now = Date.now(), delayMs = AUTO_RETEST_DELAY_MS): boolean {
  return now - bootedAtMs >= delayMs
}

/** Commit that last auto-requeued this payload, if one was recorded. */
export function requeueCommitOf(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const value = (payload as Record<string, unknown>).requeuedByCommit
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** A job requeued by another build stays on the queue for that build. */
export function mayClaimRequeuedJob(requeuedBy: string | null, mine: string): boolean {
  return !requeuedBy || requeuedBy === mine
}

export function skipNewerBuildLog(sha: string): string {
  return `skipping job requeued by newer build ${sha}`
}

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
