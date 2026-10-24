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
  const newestFirst: string[] = []
  for (let page = 0; page < 2; page++) {
    const q = new URLSearchParams({ ownerId: service.ownerId, resource: service.id, type: 'build', startTime, endTime, direction: 'backward', limit: '100' })
    const r = await call<{ logs: { message: string }[]; hasMore: boolean; nextStartTime?: string; nextEndTime?: string }>(key, `/logs?${q}`)
    newestFirst.push(...r.logs.map((l) => l.message))
    if (!r.hasMore || !r.nextStartTime || !r.nextEndTime) break
    startTime = r.nextStartTime
    endTime = r.nextEndTime
  }
  return newestFirst.reverse()
}

/** Recent deploys, with the build log of the one asked for (default: the latest that failed). */
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
    log: pick ? { deploy: pick.id, status: pick.status, lines: await buildLog(key, service, pick) } : null,
  }
}
