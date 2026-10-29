import { getSecretByName } from '@/lib/vault-service'

/**
 * The Hub's own hosting, read through Render's API with the Vault's
 * "Render API Key": recent deploys, and the build log of one, so a failed
 * deploy can be read without signing in to the Render dashboard. Read-only;
 * the key never leaves the server.
 */

const API = 'https://api.render.com/v1'
export const RENDER_VAULT_NAME = 'Render API Key'
/** The web service's name in render.yaml. */
const SERVICE_NAME = 'genisys-hub'

type Service = { id: string; name: string; ownerId: string; dashboardUrl: string }
type RawDeploy = {
  id: string
  status: string
  trigger?: string
  commit?: { id: string; message: string }
  createdAt: string
  startedAt?: string
  finishedAt?: string
}

export type RenderDeploy = {
  id: string
  status: string
  trigger: string | null
  commit: string | null
  message: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

async function call<T>(key: string, path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`Render answered ${res.status} for ${path.split('?')[0]}: ${(await res.text()).slice(0, 300)}`)
  return (await res.json()) as T
}

/** The same GET, for the other Render reader (lib/render-costs.ts). */
export const renderGet = call

async function hubService(key: string): Promise<Service> {
  const list = await call<{ service: Service }[]>(key, `/services?name=${SERVICE_NAME}&limit=20`)
  const service = list.map((x) => x.service).find((s) => s.name === SERVICE_NAME)
  if (!service) throw new Error(`The Render API key's workspace has no service named ${SERVICE_NAME}.`)
  return service
}

/** The last lines of a deploy's build log (where a failure says why), oldest first. */
async function buildLog(key: string, service: Service, d: RenderDeploy): Promise<string[]> {
  let startTime = d.startedAt ?? d.createdAt
  let endTime = d.finishedAt ?? new Date().toISOString()
  const lines: { message: string; timestamp: string }[] = []
  for (let page = 0; page < 2; page++) {
    const q = new URLSearchParams({ ownerId: service.ownerId, resource: service.id, type: 'build', startTime, endTime, direction: 'backward', limit: '100' })
    const r = await call<{ logs: { message: string; timestamp: string }[]; hasMore: boolean; nextStartTime?: string; nextEndTime?: string }>(key, `/logs?${q}`)
    lines.push(...r.logs)
    if (!r.hasMore || !r.nextStartTime || !r.nextEndTime) break
    startTime = r.nextStartTime
    endTime = r.nextEndTime
  }
  // Render's order depends on the page and the direction: put the lines in time order.
  return lines.sort((a, b) => a.timestamp.localeCompare(b.timestamp)).map((l) => l.message)
}

type Failure = { evicted?: boolean; evictionReason?: string; nonZeroExit?: number; earlyExit?: boolean; oomKilled?: { memoryLimit: string }; timedOutSeconds?: number; timedOutReason?: string; unhealthy?: string }

/** A failure reason in words: out of memory, a crash's exit code, a timeout. */
function why(f: Failure | undefined): string | null {
  if (!f) return null
  const out = [
    f.oomKilled && `out of memory (limit ${f.oomKilled.memoryLimit})`,
    f.nonZeroExit !== undefined && `exited with code ${f.nonZeroExit}`,
    f.earlyExit && 'exited early',
    f.timedOutSeconds !== undefined && `timed out after ${f.timedOutSeconds}s${f.timedOutReason ? ` (${f.timedOutReason})` : ''}`,
    f.unhealthy && `unhealthy: ${f.unhealthy}`,
    f.evicted && `evicted${f.evictionReason ? `: ${f.evictionReason}` : ''}`,
  ].filter(Boolean)
  return out.length ? out.join('; ') : null
}

const WATCHED = new Set(['build_ended', 'deploy_ended', 'server_failed', 'server_restarted', 'server_available', 'server_hardware_failure', 'zero_downtime_redeploy_ended'])

/** The last day's builds, deploys, crashes and restarts, newest first, with Render's reason for each failure. */
async function serviceEvents(key: string, service: Service): Promise<{ at: string; type: string; detail: string | null }[]> {
  const q = new URLSearchParams({ startTime: new Date(Date.now() - 24 * 60 * 60_000).toISOString(), limit: '100' })
  const list = await call<{ event: { timestamp: string; type: string; details?: Record<string, unknown> } }[]>(key, `/services/${service.id}/events?${q}`)
  return list
    .map((x) => x.event)
    .filter((e) => WATCHED.has(e.type))
    .map((e) => {
      const d = (e.details ?? {}) as { buildStatus?: string; deployStatus?: string; reason?: { failure?: Failure } & Failure; triggeredByUser?: string | null }
      const status = d.buildStatus ?? d.deployStatus ?? null
      const reason = why(d.reason?.failure) ?? why(e.type === 'server_failed' ? d.reason : undefined)
      return { at: e.timestamp, type: e.type, detail: [status, reason, e.type === 'server_restarted' && d.triggeredByUser ? `by ${d.triggeredByUser}` : null].filter(Boolean).join(' · ') || null }
    })
}

/** Recent deploys and service events, with the build log of the deploy asked for (default: the latest that failed). */
export async function renderDeploys(opts: { deployId?: string; limit?: number } = {}) {
  const key = await getSecretByName(RENDER_VAULT_NAME)
  const service = await hubService(key)
  const deploys: RenderDeploy[] = (await call<{ deploy: RawDeploy }[]>(key, `/services/${service.id}/deploys?limit=${opts.limit ?? 10}`)).map(({ deploy: d }) => ({
    id: d.id,
    status: d.status,
    trigger: d.trigger ?? null,
    commit: d.commit?.id.slice(0, 7) ?? null,
    message: d.commit?.message.split('\n')[0] ?? null,
    createdAt: d.createdAt,
    startedAt: d.startedAt ?? null,
    finishedAt: d.finishedAt ?? null,
  }))
  const pick = opts.deployId ? deploys.find((d) => d.id === opts.deployId) : deploys.find((d) => d.status.endsWith('_failed'))
  return {
    service: { id: service.id, name: service.name, dashboardUrl: service.dashboardUrl },
    deploys,
    events: await serviceEvents(key, service).catch((err) => [{ at: new Date().toISOString(), type: 'error', detail: err instanceof Error ? err.message : String(err) }]),
    log: pick ? { deploy: pick.id, status: pick.status, lines: await buildLog(key, service, pick) } : null,
  }
}

/**
 * Search the Hub's runtime (app) logs for a substring over the last
 * `minutes`. Read-only; the Render key never leaves the server and each
 * line is passed through redactSecrets before it is returned.
 */
export async function searchRuntimeLogs(opts: { text: string; minutes: number; limit: number }) {
  const { redactSecrets } = await import('@/lib/log-redact')
  const key = await getSecretByName(RENDER_VAULT_NAME)
  const service = await hubService(key)
  const q = new URLSearchParams({
    ownerId: service.ownerId,
    resource: service.id,
    type: 'app',
    startTime: new Date(Date.now() - opts.minutes * 60_000).toISOString(),
    endTime: new Date().toISOString(),
    direction: 'backward',
    limit: String(opts.limit),
  })
  if (opts.text) q.append('text', opts.text)
  const r = await call<{ logs: { message: string; timestamp: string }[]; hasMore: boolean }>(key, `/logs?${q}`)
  return {
    service: service.name,
    hasMore: r.hasMore,
    lines: (r.logs ?? [])
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .map((l) => ({ at: l.timestamp, message: redactSecrets(l.message).slice(0, 4000) })),
  }
}
