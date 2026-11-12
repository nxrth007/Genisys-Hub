/**
 * Load one existing location's snapshot and then count real records.
 * The status document's "completed" list is not that count.
 */

export const MASTER_TEMPLATE_ID = 'PsOYVeuIfXR7soMIiMcI'
export const MASTER_TEMPLATE_NAME = 'Master Template'
export const SNAPSHOT_LOAD_LOG_JOB_ID = 'cmwd45klj00013hq197b9v9e5'
/** Long enough for GHL to copy pipelines, workflows, and funnels. */
export const SNAPSHOT_LOAD_WAIT_MS = 4 * 60 * 1000

export type AssetCounts = {
  pipelines: number | null
  workflows: number | null
  funnels: number | null
  customFields: number | null
  tags: number | null
}

export const ASSET_COUNT_KEYS = ['pipelines', 'workflows', 'funnels', 'customFields', 'tags'] as const

export function emptyAssetCounts(): AssetCounts {
  return { pipelines: null, workflows: null, funnels: null, customFields: null, tags: null }
}

/** First check immediately, then every 2 minutes through 15 minutes. */
export const VERIFY_INTERVAL_MS = 2 * 60 * 1000
export const VERIFY_WINDOW_MS = 15 * 60 * 1000

export function verifyCheckTimes(windowMs = VERIFY_WINDOW_MS, intervalMs = VERIFY_INTERVAL_MS): number[] {
  const times = [0]
  while (times[times.length - 1] + intervalMs <= windowMs) times.push(times[times.length - 1] + intervalMs)
  return times
}

/** Button, tab, and menu labels to log when a control is missing. */
export function visibleControls(labels: string[], limit = 40): string {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of labels) {
    const text = raw.replace(/\s+/g, ' ').trim()
    const key = text.toLowerCase()
    if (!text || seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length >= limit) break
  }
  return out.join(' | ') || '(none)'
}

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

export function describeAssetCounts(counts: Partial<AssetCounts>): string {
  const n = (v: number | null | undefined) => (v === null || v === undefined ? 'unreadable' : String(v))
  return `${n(counts.pipelines)} pipelines, ${n(counts.workflows)} workflows, ${n(counts.funnels)} funnels, ${n(counts.customFields)} custom fields, ${n(counts.tags)} tags`
}

/**
 * Real records, not the snapshot-status type list.
 * With source counts, every asset type the snapshot actually contains must be non-zero.
 * Without them, pipelines, workflows, and funnels must all be non-zero.
 */
export function locationContentLanded(counts: AssetCounts, source?: Partial<AssetCounts> | null): { ok: boolean; reason: string } {
  const described = describeAssetCounts(counts)
  const keys = ASSET_COUNT_KEYS
  const sourceKnown = !!source && keys.some((key) => typeof source[key] === 'number')
  if (source && sourceKnown) {
    const required = keys.filter((key) => typeof source[key] === 'number' && (source[key] as number) > 0)
    if (!required.length) {
      return {
        ok: false,
        reason: `The snapshot's own asset counts are zero (${describeAssetCounts(source)}). Location has ${described}.`,
      }
    }
    const missing = required.filter((key) => counts[key] === null || counts[key] === 0)
    if (missing.length) {
      return {
        ok: false,
        reason: `Location is missing ${missing.join(', ')} that the snapshot contains. Location: ${described}. Snapshot source: ${describeAssetCounts(source)}.`,
      }
    }
    return { ok: true, reason: `Location has the snapshot's non-zero asset types. Location: ${described}.` }
  }
  if (snapshotRecordsLanded(counts)) {
    return { ok: true, reason: `Location has pipelines, workflows, and funnels. ${described}.` }
  }
  return { ok: false, reason: `Location records are not all non-zero. ${described}.` }
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

function countByUrl(url: string, body: unknown): Partial<AssetCounts> {
  const lower = url.toLowerCase()
  const out: Partial<AssetCounts> = {}
  if (/pipeline/.test(lower)) {
    const n = countNamedList(body, ['pipelines'])
    if (n !== null) out.pipelines = n
  }
  if (/workflow/.test(lower)) {
    const n = countNamedList(body, ['workflows'])
    if (n !== null) out.workflows = n
  }
  if (/funnel/.test(lower)) {
    const n = countNamedList(body, ['funnels'])
    if (n !== null) out.funnels = n
  }
  if (/customfield|custom-field|custom_field/.test(lower)) {
    const n = countNamedList(body, ['customFields', 'custom_fields', 'fields'])
    if (n !== null) out.customFields = n
  }
  if (/\/tags\b/.test(lower)) {
    const n = countNamedList(body, ['tags'])
    if (n !== null) out.tags = n
  }
  return out
}

/** A body the URL did not classify, when it has exactly one known record list. Arrays of strings are type names, not records. */
function countByBody(body: unknown): Partial<AssetCounts> | null {
  const lists: { key: keyof AssetCounts; names: string[] }[] = [
    { key: 'pipelines', names: ['pipelines'] },
    { key: 'workflows', names: ['workflows'] },
    { key: 'funnels', names: ['funnels'] },
    { key: 'customFields', names: ['customFields', 'custom_fields'] },
    { key: 'tags', names: ['tags'] },
  ]
  const found: Partial<AssetCounts> = {}
  const row = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  const data = row && row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? (row.data as Record<string, unknown>) : null
  for (const list of lists) {
    for (const name of list.names) {
      const value = row?.[name] ?? data?.[name]
      if (!Array.isArray(value) || value.some((item) => typeof item === 'string')) continue
      found[list.key] = value.length
      break
    }
  }
  return Object.keys(found).length === 1 ? found : null
}

/** Ignore a payload that is not for this location. snapshot-status is a push document, not these counts. */
export function countsFromAssetPayload(url: string, body: unknown, locationId: string): Partial<AssetCounts> | null {
  if (!url.includes(locationId) || /snapshot-status/i.test(url)) return null
  const fromUrl = countByUrl(url, body)
  if (Object.keys(fromUrl).length) return fromUrl
  return countByBody(body)
}

export function locationAssetPages(origin: string, locationId: string): { kind: keyof AssetCounts; url: string }[] {
  const base = origin.replace(/\/$/, '')
  const id = encodeURIComponent(locationId)
  return [
    { kind: 'pipelines', url: `${base}/v2/location/${id}/opportunities/pipelines` },
    { kind: 'workflows', url: `${base}/v2/location/${id}/automation/workflows` },
    { kind: 'funnels', url: `${base}/v2/location/${id}/funnels-websites/funnels` },
    { kind: 'customFields', url: `${base}/v2/location/${id}/settings/fields` },
    { kind: 'tags', url: `${base}/v2/location/${id}/settings/tags` },
  ]
}

/** Agency Account Snapshots. Create-sub-account routes are not in this list. */
export function agencySnapshotUrls(origin: string): string[] {
  const base = origin.replace(/\/$/, '')
  return [
    `${base}/snapshots`,
    `${base}/settings/snapshots`,
    `${base}/agency/snapshots`,
    `${base}/v2/agency/snapshots`,
    `${base}/accounts/snapshots`,
  ]
}

/** Stay on the agency snapshot pages. A location switch or a create route is refused. */
export function agencyPushUrlAllowed(url: string): boolean {
  if (!url) return false
  if (/accounts\/search|add-sub|create-sub|accounts\/create|locations\/create|sub-accounts\/create/i.test(url)) return false
  if (/\/location\/[A-Za-z0-9]{10,}/i.test(url)) return false
  return true
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
    if (!open) {
      return {
        type: 'stop',
        ok: false,
        reason: `Load snapshot was not on this location page. Visible controls: ${visibleControls(input.labels)}. Nothing else was clicked.`,
      }
    }
    return { type: 'click', click: { label: open, contains: false, progress: { ...progress, opened: true } } }
  }
  if (!progress.picked) {
    const name = input.snapshotName.trim()
    const pick = labels.find((label) => label.trim() === name || label.includes(input.snapshotId) || (name && label.includes(name)))
    if (!pick) {
      return {
        type: 'stop',
        ok: false,
        reason: `Could not find ${name || input.snapshotId} on the load dialog. Visible controls: ${visibleControls(input.labels)}. Nothing else was clicked.`,
      }
    }
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
      return {
        type: 'stop',
        ok: false,
        reason: `The load dialog had no confirm button. Visible controls: ${visibleControls(input.labels)}. Create was not pressed.`,
      }
    }
    return { type: 'click', click: { label: confirm, contains: false, progress: { ...progress, confirmed: true } } }
  }
  const chosen = progress.overwrite.length ? progress.overwrite.join(', ') : 'none offered'
  return { type: 'stop', ok: true, reason: `Pressed load for ${input.snapshotName} (${input.snapshotId}). Overwrite options: ${chosen}.` }
}
