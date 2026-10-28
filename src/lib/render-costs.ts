import { prisma } from '@/lib/prisma'
import { getSecretByName } from '@/lib/vault-service'
import { RENDER_VAULT_NAME, renderGet } from '@/lib/render'

/**
 * What the Hub's Render workspace costs a month, for Settings → Render costs.
 *
 * Render's API has no billing endpoint, so this prices what the API does
 * report (every service's and database's plan, disks, Postgres storage, and
 * this month's bandwidth and build time) with Render's published prices
 * below. The workspace plan isn't in the API either: an admin picks it once in
 * Settings. Render bills by the second and its billing page has the invoice,
 * so this is an estimate.
 */

/* Prices from render.com/pricing, read 2026-10-27. When Render changes them, change them here. */

export const WORKSPACE_PLANS = {
  hobby: { label: 'Hobby', fee: 0, bandwidthGB: 5, buildMinutes: 500 },
  pro: { label: 'Pro', fee: 25, bandwidthGB: 25, buildMinutes: 1000 },
  scale: { label: 'Scale', fee: 499, bandwidthGB: 1000, buildMinutes: 5000 },
}
export type WorkspacePlan = keyof typeof WORKSPACE_PLANS
const BANDWIDTH_PER_GB = 0.15
const BUILD_PER_MINUTE = 5 / 1000
const DISK_PER_GB = 0.25
const POSTGRES_PER_GB = 0.3

/** Web services, private services and background workers: a month per instance, by plan ID. */
const COMPUTE: Record<string, number> = {
  free: 0, '0.5c-512mb': 7, '1c-2g': 25, '2c-4g': 85, '2c-8g': 135, '2c-16g': 200, '4c-8g': 175, '4c-16g': 225,
  '4c-32g': 350, '8c-16g': 300, '8c-32g': 450, '8c-64g': 1000, '12c-24g': 450, '12c-48g': 800, '12c-96g': 1500,
}
/** Older plan names the API can still report, and the plan ID each one is now. */
const COMPUTE_NAMES: Record<string, string> = {
  starter: '0.5c-512mb', standard: '1c-2g', pro: '2c-4g', pro_plus: '4c-8g', pro_max: '4c-16g', pro_ultra: '8c-32g',
}
/** Postgres compute, a month; storage is on top, per GB. */
const POSTGRES: Record<string, number> = {
  free: 0, '0.1c-256mb': 6, '0.5c-1g': 19, '1c-2g': 40, '1c-4g': 55, '2c-4g': 75, '2c-8g': 100, '2c-16g': 160,
  '4c-16g': 200, '4c-32g': 350, '8c-32g': 400, '8c-64g': 750, '16c-64g': 800, '16c-128g': 1500, '32c-128g': 1700,
  '32c-256g': 2500, '48c-192g': 2500, '48c-384g': 4500, '64c-256g': 3000, '64c-512g': 6000, '96c-384g': 4600,
  '96c-768g': 9000, '128c-512g': 6200, '128c-1024g': 11000,
}
const POSTGRES_NAMES: Record<string, string> = {
  basic_256mb: '0.1c-256mb', basic_1gb: '0.5c-1g', basic_4gb: '2c-4g',
  pro_4gb: '1c-4g', pro_8gb: '2c-8g', pro_16gb: '4c-16g', pro_32gb: '8c-32g', pro_64gb: '16c-64g', pro_128gb: '32c-128g',
  pro_192gb: '48c-192g', pro_256gb: '64c-256g', pro_384gb: '96c-384g', pro_512gb: '128c-512g',
  accelerated_16gb: '2c-16g', accelerated_32gb: '4c-32g', accelerated_64gb: '8c-64g', accelerated_128gb: '16c-128g',
  accelerated_256gb: '32c-256g', accelerated_384gb: '48c-384g', accelerated_512gb: '64c-512g',
  accelerated_768gb: '96c-768g', accelerated_1024gb: '128c-1024g',
}
const KEY_VALUE: Record<string, number> = {
  free: 0, '256mb': 10, '1g': 20, '3g': 60, '5g': 100, '10g': 200, '20g': 350, '40g': 600, '50g': 750,
}
const KEY_VALUE_NAMES: Record<string, string> = { starter: '256mb' }

export type CostLine = {
  name: string
  /** What it is and what it runs on, e.g. "Web service · starter (0.5 CPU, 512 MB)". */
  detail: string
  /** Dollars a month; null when the price list doesn't cover it. */
  monthly: number | null
  url: string | null
}

export type RenderCosts = {
  plan: WorkspacePlan | null
  plans: { id: WorkspacePlan; label: string; fee: number }[]
  lines: CostLine[]
  /** Everything priced, a month. */
  total: number
  /** Lines the price list doesn't cover, left out of the total. */
  unpriced: number
  usage: {
    since: string
    bandwidthGB: number | null
    includedGB: number | null
    buildMinutes: number | null
    includedMinutes: number | null
    error: string | null
  }
  checkedAt: string
}

type Service = {
  id: string
  name: string
  type: string
  suspended?: string
  dashboardUrl?: string
  serviceDetails?: {
    plan?: string
    numInstances?: number
    autoscaling?: { enabled?: boolean; min?: number; max?: number }
    disk?: { sizeGB?: number }
  }
}
type Postgres = { name: string; plan?: string; diskSizeGB?: number; highAvailabilityEnabled?: boolean; role?: string; dashboardUrl?: string }
type KeyValue = { name: string; plan?: string; dashboardUrl?: string }
type Deploy = { createdAt: string; startedAt?: string; finishedAt?: string }

/** A plan's monthly price and the plan ID it was priced as; null when it isn't in the list (custom, retired). */
function price(table: Record<string, number>, names: Record<string, string>, plan: string | undefined) {
  const raw = (plan ?? '').trim().toLowerCase()
  const old = raw.replace(/-/g, '_')
  const id = Object.hasOwn(table, raw) ? raw : Object.hasOwn(names, old) ? names[old] : null
  return id ? { id, monthly: table[id] } : null
}

/** "0.5c-512mb" → "0.5 CPU, 512 MB". */
function machine(id: string): string {
  const m = /^([\d.]+)c-(\d+)(mb|g)$/.exec(id)
  return m ? `${m[1]} CPU, ${m[2]} ${m[3] === 'mb' ? 'MB' : 'GB'}` : id
}

/** A plan as Render reports it, with the machine when the name doesn't say. */
function planLabel(plan: string | undefined, priced: { id: string } | null): string {
  const raw = (plan ?? '').trim() || 'no plan'
  if (!priced || priced.id === 'free') return raw
  return raw.toLowerCase() === priced.id ? machine(priced.id) : `${raw} (${machine(priced.id)})`
}

const KIND: Record<string, string> = {
  web_service: 'Web service',
  private_service: 'Private service',
  background_worker: 'Background worker',
  cron_job: 'Cron job',
  static_site: 'Static site',
}

function serviceLine(s: Service): CostLine {
  const d = s.serviceDetails ?? {}
  const kind = KIND[s.type] ?? s.type
  const base = { name: s.name, url: s.dashboardUrl ?? null }
  if (s.type === 'static_site') return { ...base, detail: `${kind} · free, only its bandwidth counts`, monthly: 0 }
  const priced = price(COMPUTE, COMPUTE_NAMES, d.plan)
  if (s.type === 'cron_job') {
    return { ...base, detail: `${kind} · ${planLabel(d.plan, priced)}, billed for the minutes it runs`, monthly: null }
  }
  const auto = d.autoscaling?.enabled ? d.autoscaling : null
  // Autoscaling is priced at its floor: what it costs when nothing scales up.
  const instances = Math.max(1, (auto ? auto.min : d.numInstances) ?? 1)
  const diskGB = d.disk?.sizeGB ?? 0
  const suspended = s.suspended === 'suspended'
  const parts = [
    planLabel(d.plan, priced),
    auto ? `autoscaling ${auto.min ?? 1}–${auto.max ?? '?'} instances, priced at ${instances}` : instances > 1 ? `${instances} instances` : null,
    diskGB ? `${diskGB} GB disk` : null,
    suspended ? 'suspended, so only a disk is billed' : null,
  ].filter(Boolean)
  return {
    ...base,
    detail: `${kind} · ${parts.join(', ')}`,
    monthly: priced ? (suspended ? 0 : priced.monthly * instances) + diskGB * DISK_PER_GB : null,
  }
}

function postgresLine(p: Postgres): CostLine {
  const priced = price(POSTGRES, POSTGRES_NAMES, p.plan)
  const gb = p.diskSizeGB ?? 0
  const parts = [
    planLabel(p.plan, priced),
    gb ? `${gb} GB storage` : null,
    p.highAvailabilityEnabled ? 'high availability, so billed twice' : null,
  ].filter(Boolean)
  return {
    name: p.name,
    detail: `Postgres${p.role === 'replica' ? ' read replica' : ''} · ${parts.join(', ')}`,
    monthly: priced
      ? (priced.monthly + (priced.id === 'free' ? 0 : gb * POSTGRES_PER_GB)) * (p.highAvailabilityEnabled ? 2 : 1)
      : null,
    url: p.dashboardUrl ?? null,
  }
}

function keyValueLine(k: KeyValue): CostLine {
  return {
    name: k.name,
    detail: `Key Value · ${k.plan || 'no plan'}`,
    monthly: price(KEY_VALUE, KEY_VALUE_NAMES, k.plan)?.monthly ?? null,
    url: k.dashboardUrl ?? null,
  }
}

/** Every row of a Render list endpoint (they page by cursor, 100 at most). */
async function listAll<T>(key: string, path: string, wrapper: string): Promise<T[]> {
  const out: T[] = []
  let cursor = ''
  for (let page = 0; page < 10; page++) {
    const sep = path.includes('?') ? '&' : '?'
    const rows = await renderGet<Record<string, unknown>[]>(key, `${path}${sep}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    out.push(...rows.map((r) => r[wrapper] as T))
    cursor = rows.length === 100 ? String(rows[99].cursor ?? '') : ''
    if (!cursor) break
  }
  return out
}

const GB_PER_UNIT: Record<string, number> = { gb: 1, mb: 1e-3, kb: 1e-6, b: 1e-9, bytes: 1e-9 }

/** What the services have served since `since`, in GB. Each point is its interval's traffic, so they add up. */
async function bandwidthGB(key: string, services: Service[], since: string): Promise<number> {
  const ids = services.filter((s) => s.type === 'web_service' || s.type === 'static_site').map((s) => s.id)
  if (!ids.length) return 0
  const q = new URLSearchParams({ startTime: since, endTime: new Date().toISOString() })
  for (const id of ids) q.append('resource', id)
  const series = await renderGet<{ unit?: string; values?: { value: number }[] }[]>(key, `/metrics/bandwidth?${q}`)
  let total = 0
  for (const s of series) {
    const per = GB_PER_UNIT[(s.unit ?? 'GB').toLowerCase()]
    if (per === undefined) throw new Error(`Render reported bandwidth in "${s.unit}"`)
    total += (s.values ?? []).reduce((n, v) => n + (Number(v.value) || 0), 0) * per
  }
  return total
}

/**
 * Build time since `since`, in minutes, rounded up per deploy. Taken from
 * each deploy's start and finish, which also covers the minute or so of
 * starting the new version, so it runs a little high.
 */
async function buildMinutes(key: string, services: Service[], since: string): Promise<number> {
  let total = 0
  for (const s of services) {
    const deploys = await listAll<Deploy>(key, `/services/${s.id}/deploys?createdAfter=${encodeURIComponent(since)}`, 'deploy')
    for (const d of deploys) {
      const ms = d.finishedAt ? Date.parse(d.finishedAt) - Date.parse(d.startedAt ?? d.createdAt) : 0
      if (ms > 0) total += Math.ceil(ms / 60_000)
    }
  }
  return total
}

type Snapshot = {
  lines: CostLine[]
  bandwidthGB: number | null
  buildMinutes: number | null
  usageError: string | null
  since: string
  checkedAt: string
}

/** Render is read at most every 10 minutes; Refresh on the card skips the wait. */
const SNAPSHOT_MS = 10 * 60_000
let cache: { at: number; snap: Snapshot } | null = null

async function snapshot(refresh: boolean): Promise<Snapshot> {
  if (!refresh && cache && Date.now() - cache.at < SNAPSHOT_MS) return cache.snap
  const key = await getSecretByName(RENDER_VAULT_NAME)
  const now = new Date()
  // Render bills by calendar month.
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
  const [services, databases, keyValues] = await Promise.all([
    listAll<Service>(key, '/services', 'service'),
    listAll<Postgres>(key, '/postgres', 'postgres'),
    listAll<KeyValue>(key, '/key-value', 'keyValue'),
  ])
  const [bandwidth, build] = await Promise.allSettled([bandwidthGB(key, services, since), buildMinutes(key, services, since)])
  const failed = [bandwidth, build].find((r) => r.status === 'rejected')
  const snap: Snapshot = {
    lines: [...services.map(serviceLine), ...databases.map(postgresLine), ...keyValues.map(keyValueLine)],
    bandwidthGB: bandwidth.status === 'fulfilled' ? bandwidth.value : null,
    buildMinutes: build.status === 'fulfilled' ? build.value : null,
    usageError: failed ? String(failed.reason instanceof Error ? failed.reason.message : failed.reason) : null,
    since,
    checkedAt: now.toISOString(),
  }
  cache = { at: Date.now(), snap }
  return snap
}

const PLAN_KEY = 'render.workspacePlan'

export function isWorkspacePlan(v: unknown): v is WorkspacePlan {
  return typeof v === 'string' && Object.hasOwn(WORKSPACE_PLANS, v)
}

export async function setWorkspacePlan(plan: WorkspacePlan): Promise<void> {
  await prisma.appSetting.upsert({ where: { key: PLAN_KEY }, create: { key: PLAN_KEY, value: plan }, update: { value: plan } })
}

export async function renderCosts(opts: { refresh?: boolean } = {}): Promise<RenderCosts> {
  const [snap, row] = await Promise.all([snapshot(!!opts.refresh), prisma.appSetting.findUnique({ where: { key: PLAN_KEY } })])
  const plan = isWorkspacePlan(row?.value) ? row.value : null
  const p = plan ? WORKSPACE_PLANS[plan] : null
  const lines = [...snap.lines]
  if (p) {
    lines.unshift({
      name: `${p.label} workspace plan`,
      detail: `Includes ${p.bandwidthGB.toLocaleString('en-US')} GB of bandwidth and ${p.buildMinutes.toLocaleString('en-US')} build minutes a month`,
      monthly: p.fee,
      url: null,
    })
    const overGB = (snap.bandwidthGB ?? 0) - p.bandwidthGB
    if (overGB > 0) {
      lines.push({ name: 'Bandwidth over the plan', detail: `${overGB.toFixed(1)} GB so far this month, at $${BANDWIDTH_PER_GB} a GB`, monthly: overGB * BANDWIDTH_PER_GB, url: null })
    }
    const overMinutes = (snap.buildMinutes ?? 0) - p.buildMinutes
    if (overMinutes > 0) {
      lines.push({ name: 'Build minutes over the plan', detail: `${overMinutes.toLocaleString('en-US')} minutes so far this month, at $5 per 1,000`, monthly: overMinutes * BUILD_PER_MINUTE, url: null })
    }
  }
  return {
    plan,
    plans: (Object.keys(WORKSPACE_PLANS) as WorkspacePlan[]).map((id) => ({ id, label: WORKSPACE_PLANS[id].label, fee: WORKSPACE_PLANS[id].fee })),
    lines,
    total: lines.reduce((n, l) => n + (l.monthly ?? 0), 0),
    unpriced: lines.filter((l) => l.monthly === null).length,
    usage: {
      since: snap.since,
      bandwidthGB: snap.bandwidthGB,
      includedGB: p?.bandwidthGB ?? null,
      buildMinutes: snap.buildMinutes,
      includedMinutes: p?.buildMinutes ?? null,
      error: snap.usageError,
    },
    checkedAt: snap.checkedAt,
  }
}
