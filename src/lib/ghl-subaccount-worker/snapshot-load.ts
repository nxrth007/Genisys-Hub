/**
 * Load one existing location's snapshot and then count real records.
 * The status document's "completed" list is not that count.
 */

export const MASTER_TEMPLATE_ID = 'PsOYVeuIfXR7soMIiMcI'
export const MASTER_TEMPLATE_NAME = 'Master Template'
export const SNAPSHOT_LOAD_LOG_JOB_ID = 'cmwd45klj00013hq197b9v9e5'
/** Long enough for GHL to copy pipelines, workflows, and funnels. */
export const SNAPSHOT_LOAD_WAIT_MS = 4 * 60 * 1000

export type AssetCounts = { pipelines: number | null; workflows: number | null; funnels: number | null }

export function snapshotLoadLocationIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.GHL_SNAPSHOT_LOAD_LOCATION_IDS ?? '').split(/[,\s]+/).map((id) => id.trim()).filter(Boolean)
}

export function pendingSnapshotLoads(ids: string[], done: string[]): string[] {
  const seen = new Set(done)
  return ids.filter((id) => !seen.has(id))
}

/** A finished load has real rows of each kind. A "completed" status is not enough. */
export function snapshotRecordsLanded(counts: AssetCounts): boolean {
  return (counts.pipelines ?? 0) > 0 && (counts.workflows ?? 0) > 0 && (counts.funnels ?? 0) > 0
}

export function describeAssetCounts(counts: AssetCounts): string {
  const n = (v: number | null) => (v === null ? 'unreadable' : String(v))
  return `${n(counts.pipelines)} pipelines, ${n(counts.workflows)} workflows, ${n(counts.funnels)} funnels`
}

export function countNamedList(body: unknown, keys: string[]): number | null {
  if (Array.isArray(body)) return body.length
  if (!body || typeof body !== 'object') return null
  const row = body as Record<string, unknown>
  for (const key of keys) {
    if (Array.isArray(row[key])) return row[key].length
  }
  if (row.data) return countNamedList(row.data, keys)
  return null
}

/** Ignore a payload that is not for this location. */
export function countsFromAssetPayload(url: string, body: unknown, locationId: string): Partial<AssetCounts> | null {
  if (!url.includes(locationId)) return null
  const lower = url.toLowerCase()
  if (/pipeline/.test(lower)) {
    const n = countNamedList(body, ['pipelines'])
    return n === null ? null : { pipelines: n }
  }
  if (/workflow/.test(lower)) {
    const n = countNamedList(body, ['workflows'])
    return n === null ? null : { workflows: n }
  }
  if (/funnel/.test(lower)) {
    const n = countNamedList(body, ['funnels'])
    return n === null ? null : { funnels: n }
  }
  return null
}

export function locationAssetPages(origin: string, locationId: string): { kind: keyof AssetCounts; url: string }[] {
  const base = origin.replace(/\/$/, '')
  const id = encodeURIComponent(locationId)
  return [
    { kind: 'pipelines', url: `${base}/v2/location/${id}/opportunities/pipelines` },
    { kind: 'workflows', url: `${base}/v2/location/${id}/automation/workflows` },
    { kind: 'funnels', url: `${base}/v2/location/${id}/funnels-websites/funnels` },
  ]
}

/** Stay on this location. Create-sub-account routes are refused. */
export function snapshotLoadUrlAllowed(url: string, locationId: string): boolean {
  if (!url || !locationId || !url.includes(locationId)) return false
  return !/accounts\/search|add-sub|create-sub|sub-accounts\/create|locations\/create/i.test(url)
}

export function isForbiddenSnapshotClick(label: string): boolean {
  return /add sub-account|create sub-account|create location|add manually|new sub-account|create account/i.test(label)
}

const OVERWRITE = /overwrite|override|import all|select all|all assets|replace existing/i
const CONFIRM = /^(proceed|load snapshot|import|push|push snapshot|push to sub-account|confirm|apply|yes|continue|load|yes, load|import snapshot)$/i

export type SnapshotLoadProgress = {
  opened: boolean
  picked: boolean
  overwrite: string[]
  confirmed: boolean
}

export function freshSnapshotLoad(): SnapshotLoadProgress {
  return { opened: false, picked: false, overwrite: [], confirmed: false }
}

export type SnapshotLoadClick = { label: string; contains: boolean; progress: SnapshotLoadProgress }
export type SnapshotLoadDecision = { type: 'click'; click: SnapshotLoadClick } | { type: 'stop'; ok: boolean; reason: string }

export function nextSnapshotLoadAction(input: {
  url: string
  locationId: string
  labels: string[]
  body: string
  snapshotName: string
  snapshotId: string
  progress: SnapshotLoadProgress
}): SnapshotLoadDecision {
  if (!snapshotLoadUrlAllowed(input.url, input.locationId)) {
    return { type: 'stop', ok: false, reason: `Refusing to click. The page is not location ${input.locationId}.` }
  }
  if (/sign in|log in|password/i.test(input.body) && !/snapshot/i.test(input.body)) {
    return { type: 'stop', ok: false, reason: 'The snapshot page is signed out. Nothing was clicked.' }
  }
  const labels = input.labels.filter((label) => !isForbiddenSnapshotClick(label))
  const progress = input.progress
  if (!progress.opened) {
    const open = labels.find((label) => /^(load snapshot|push snapshot|push to sub-account)$/i.test(label.trim()))
    if (!open) return { type: 'stop', ok: false, reason: 'Load snapshot was not on this location page. Nothing else was clicked.' }
    return { type: 'click', click: { label: open, contains: false, progress: { ...progress, opened: true } } }
  }
  if (!progress.picked) {
    const name = input.snapshotName.trim()
    const pick = labels.find((label) => label.trim() === name || label.includes(input.snapshotId) || (name && label.includes(name)))
    if (!pick) return { type: 'stop', ok: false, reason: `Could not find ${name || input.snapshotId} on the load dialog. Nothing else was clicked.` }
    return { type: 'click', click: { label: pick, contains: true, progress: { ...progress, picked: true } } }
  }
  const overwrite = labels.find((label) => OVERWRITE.test(label) && !progress.overwrite.includes(label.trim()))
  if (overwrite) {
    return {
      type: 'click',
      click: { label: overwrite, contains: true, progress: { ...progress, overwrite: [...progress.overwrite, overwrite.trim()] } },
    }
  }
  if (!progress.confirmed) {
    const matches = labels.filter((label) => CONFIRM.test(label.trim()))
    const confirm = matches.find((label) => /^(proceed|import|confirm|apply|yes|import snapshot|yes, load)$/i.test(label.trim())) ?? matches[0]
    if (!confirm) {
      return { type: 'stop', ok: false, reason: 'The load dialog had no confirm button. Create was not pressed.' }
    }
    return { type: 'click', click: { label: confirm, contains: false, progress: { ...progress, confirmed: true } } }
  }
  const chosen = progress.overwrite.length ? progress.overwrite.join(', ') : 'none offered'
  return { type: 'stop', ok: true, reason: `Pressed load for ${input.snapshotName} (${input.snapshotId}). Overwrite options: ${chosen}.` }
}
