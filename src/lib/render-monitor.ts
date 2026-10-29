import { createHash } from 'node:crypto'

/**
 * Watches the Hub's own Render service and texts Ethan when something breaks:
 * a failed/canceled deploy, error-level log lines, a suspended service, or
 * /api/health not answering. Runs inside the Hub (scheduler.ts, every 5 min),
 * no outside services besides Render's API and the existing GHL SMS line.
 *
 * Off unless RENDER_MONITOR_ENABLED=1. The Render key is the Vault entry
 * "Render API Key" (same as lib/render.ts; override the name with
 * RENDER_MONITOR_VAULT_ENTRY). Service: RENDER_MONITOR_SERVICE_ID, else the
 * service named "genisys-hub" (RENDER_MONITOR_SERVICE_NAME).
 *
 * Noise control: each distinct problem (fingerprint = kind + message with
 * numbers/ids stripped) alerts at most once per hour; repeats are counted and
 * reported in one hourly digest; at most MAX_TEXTS_PER_HOUR texts in total.
 *
 * This file has no Hub imports (everything comes in through `deps`) so it can
 * be unit-tested with mocked Render responses; lib/render-monitor-run.ts wires it up.
 */

export const HOUR = 60 * 60_000
export const MAX_TEXTS_PER_HOUR = 6
const FAILED_DEPLOY = new Set(['build_failed', 'update_failed', 'pre_deploy_failed', 'canceled', 'deactivated'])

export type Problem = { kind: 'deploy' | 'log' | 'heartbeat' | 'service' | 'monitor'; fingerprint: string; summary: string; at: string }

export type FpState = { firstAt: string; lastSeenAt: string; lastAlertAt: string | null; repeats: number; summary: string }
export type MonitorState = {
  fingerprints: Record<string, FpState>
  lastDigestAt: string | null
  textsSent: string[]
  heartbeatFailures: number
  seenDeploys: string[]
}

export const emptyState = (): MonitorState => ({ fingerprints: {}, lastDigestAt: null, textsSent: [], heartbeatFailures: 0, seenDeploys: [] })

export type MonitorDeps = {
  apiKey: string
  serviceId?: string | null
  serviceName?: string
  healthUrl: string
  windowMinutes: number
  now: () => number
  fetch: typeof fetch
  loadState: () => Promise<MonitorState | null>
  saveState: (s: MonitorState) => Promise<void>
  sendText: (text: string) => Promise<boolean>
}

export type MonitorResult = { problems: Problem[]; texts: string[]; sent: number; dryRun: boolean; serviceId: string | null }

/** Strip what changes between repeats of the same error (numbers, ids, hex, quoted values). */
export function normalizeMessage(msg: string): string {
  return msg
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b(?:c[a-z0-9]{20,}|[0-9a-f]{12,})\b/gi, '<id>')
    .replace(/\d+(?:\.\d+)?/g, '#')
    .replace(/(["'`]).{0,200}?\1/g, '<v>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

export function fingerprint(kind: Problem['kind'], msg: string): string {
  return createHash('sha256').update(`${kind}|${normalizeMessage(msg)}`).digest('hex').slice(0, 16)
}

const mk = (kind: Problem['kind'], key: string, summary: string, at: string): Problem => ({ kind, fingerprint: fingerprint(kind, key), summary: summary.slice(0, 220), at })

async function renderGet<T>(deps: MonitorDeps, path: string): Promise<T> {
  const res = await deps.fetch(`https://api.render.com/v1${path}`, {
    headers: { authorization: `Bearer ${deps.apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`Render answered ${res.status} for ${path.split('?')[0]}`)
  return (await res.json()) as T
}

type Svc = { id: string; name: string; ownerId: string; suspended?: string }

/** Collect what's wrong right now. Never throws: a broken check becomes a 'monitor' problem. */
export async function collectProblems(deps: MonitorDeps, state: MonitorState): Promise<{ problems: Problem[]; serviceId: string | null; deployIds: string[] }> {
  const now = deps.now()
  const iso = new Date(now).toISOString()
  const problems: Problem[] = []
  let service: Svc | null = null
  const deployIds: string[] = []
  try {
    const list = await renderGet<{ service: Svc }[]>(deps, `/services?limit=50`)
    const all = list.map((x) => x.service)
    service = (deps.serviceId ? all.find((s) => s.id === deps.serviceId) : all.find((s) => s.name === (deps.serviceName ?? 'genisys-hub'))) ?? null
    if (!service) problems.push(mk('monitor', 'service-missing', `Render monitor: service ${deps.serviceId ?? deps.serviceName ?? 'genisys-hub'} not found in the Render workspace`, iso))
    else if (service.suspended && service.suspended !== 'not_suspended') problems.push(mk('service', 'suspended', `Render service ${service.name} is suspended`, iso))
  } catch (err) {
    problems.push(mk('monitor', 'services-api', `Render monitor can't list services: ${err instanceof Error ? err.message : String(err)}`, iso))
  }

  if (service) {
    try {
      const deploys = await renderGet<{ deploy: { id: string; status: string; finishedAt?: string; createdAt: string; commit?: { id: string; message: string } } }[]>(deps, `/services/${service.id}/deploys?limit=10`)
            const since = now - deps.windowMinutes * 60_000
      for (const { deploy: d } of deploys) {
        const at = Date.parse(d.finishedAt ?? d.createdAt)
        if (!FAILED_DEPLOY.has(d.status) || state.seenDeploys.includes(d.id) || at < since - HOUR) continue
        const commit = d.commit ? ` (${d.commit.id.slice(0, 7)} ${d.commit.message.split('\n')[0].slice(0, 60)})` : ''
        deployIds.push(d.id)
        problems.push(mk('deploy', `${d.status}|${d.id}`, `Render deploy ${d.status.replace(/_/g, ' ')}${commit}`, new Date(at).toISOString()))
      }
    } catch (err) {
      problems.push(mk('monitor', 'deploys-api', `Render monitor can't read deploys: ${err instanceof Error ? err.message : String(err)}`, iso))
    }
    try {
      const q = new URLSearchParams({
        ownerId: service.ownerId,
        resource: service.id,
        level: 'error',
        startTime: new Date(now - deps.windowMinutes * 60_000).toISOString(),
        endTime: iso,
        direction: 'backward',
        limit: '100',
      })
      const r = await renderGet<{ logs: { message: string; timestamp: string }[] }>(deps, `/logs?${q}`)
      const byFp = new Map<string, Problem>()
      for (const l of r.logs ?? []) {
        const p = mk('log', l.message, `Error log: ${l.message.trim()}`, l.timestamp)
        if (!byFp.has(p.fingerprint)) byFp.set(p.fingerprint, p)
      }
      problems.push(...byFp.values())
    } catch (err) {
      problems.push(mk('monitor', 'logs-api', `Render monitor can't read logs: ${err instanceof Error ? err.message : String(err)}`, iso))
    }
  }

  // Heartbeat: two misses in a row (≈10 min) before alerting, so one slow restart isn't a text.
  let healthy = false
  try {
    const res = await deps.fetch(deps.healthUrl, { signal: AbortSignal.timeout(10_000), cache: 'no-store' })
    healthy = res.ok
  } catch {
    healthy = false
  }
  state.heartbeatFailures = healthy ? 0 : state.heartbeatFailures + 1
  if (state.heartbeatFailures >= 2) problems.push(mk('heartbeat', 'health-down', `Hub health check failing (${deps.healthUrl}, ${state.heartbeatFailures} checks in a row)`, iso))

  return { problems, serviceId: service?.id ?? null, deployIds }
}

/** Decide which texts to send given problems and state (mutates state). Pure. */
export function planAlerts(problems: Problem[], state: MonitorState, now: number): string[] {
  const iso = new Date(now).toISOString()
  state.textsSent = state.textsSent.filter((t) => now - Date.parse(t) < HOUR)
  const fresh: Problem[] = []
  for (const p of problems) {
    const f = state.fingerprints[p.fingerprint]
    if (!f) {
      state.fingerprints[p.fingerprint] = { firstAt: iso, lastSeenAt: iso, lastAlertAt: null, repeats: 0, summary: p.summary }
      fresh.push(p)
      continue
    }
    f.lastSeenAt = iso
    f.summary = p.summary
    if (!f.lastAlertAt || now - Date.parse(f.lastAlertAt) >= HOUR) fresh.push(p)
    else f.repeats++
  }
  const texts: string[] = []
  if (fresh.length) {
    const lines = fresh.slice(0, 4).map((p) => `• ${p.summary}`)
    if (fresh.length > 4) lines.push(`• …and ${fresh.length - 4} more`)
    texts.push(`Genisys Hub alert (Render):\n${lines.join('\n')}`)
    for (const p of fresh) {
      const f = state.fingerprints[p.fingerprint]
      f.lastAlertAt = iso
      f.repeats = 0
    }
  }
  // Hourly digest of repeats that were held back.
  const held = Object.values(state.fingerprints).filter((f) => f.repeats > 0)
  if (held.length && (!state.lastDigestAt || now - Date.parse(state.lastDigestAt) >= HOUR)) {
    texts.push(`Genisys Hub hourly digest (Render): ${held.map((f) => `${f.summary.slice(0, 80)} ×${f.repeats}`).join('; ')}`.slice(0, 600))
    for (const f of held) f.repeats = 0
    state.lastDigestAt = iso
  }
  // Forget problems not seen for a day.
  for (const [k, f] of Object.entries(state.fingerprints)) if (now - Date.parse(f.lastSeenAt) > 24 * HOUR) delete state.fingerprints[k]
  const room = Math.max(0, MAX_TEXTS_PER_HOUR - state.textsSent.length)
  return texts.slice(0, room)
}

/** One monitor pass. With dryRun, nothing is texted or saved; the planned texts are returned. */
export async function runRenderMonitor(deps: MonitorDeps, opts: { dryRun?: boolean } = {}): Promise<MonitorResult> {
  const dryRun = !!opts.dryRun
  const state = (await deps.loadState().catch(() => null)) ?? emptyState()
  const { problems, serviceId, deployIds } = await collectProblems(deps, state)
  const texts = planAlerts(problems, state, deps.now())
  let sent = 0
  if (!dryRun) {
    for (const t of texts) {
      if (await deps.sendText(t).catch(() => false)) {
        sent++
        state.textsSent.push(new Date(deps.now()).toISOString())
      }
    }
    state.seenDeploys = [...new Set([...state.seenDeploys, ...deployIds])].slice(-50)
    await deps.saveState(state)
  }
  return { problems, texts, sent, dryRun, serviceId }
}
