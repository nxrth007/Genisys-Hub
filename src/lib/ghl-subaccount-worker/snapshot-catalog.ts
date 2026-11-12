/**
 * Read-only parse of the snapshot JSON the agency UI loads, and the
 * decisions for pushing one snapshot into one existing location.
 * Nothing here clicks, creates, or deletes.
 */
import {
  describeAssetCounts,
  emptyAssetCounts,
  visibleControls,
  type AssetCounts,
} from './snapshot-load'

export type SnapshotRow = {
  id: string
  name: string
  type: string
  source: string
  counts: AssetCounts
}

const COUNT_FIELDS: { key: keyof AssetCounts; names: string[] }[] = [
  { key: 'pipelines', names: ['pipelines', 'pipeline'] },
  { key: 'workflows', names: ['workflows', 'workflow'] },
  { key: 'funnels', names: ['funnels', 'funnel'] },
  { key: 'customFields', names: ['customfields', 'customfield'] },
  { key: 'tags', names: ['tags', 'tag'] },
]

const NESTS = ['assets', 'data', 'snapshotData', 'assetData', 'compiled', 'counts', 'assetCounts', 'compiledAssetTitleData']

function normKey(key: string): string {
  return key.replace(/[_-]/g, '').toLowerCase()
}

/** A number, or an array of records. An array of strings is a type list, not a count. */
function asCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (!Array.isArray(value)) return null
  if (value.some((item) => typeof item === 'string')) return null
  return value.length
}

function readCounts(obj: Record<string, unknown>): AssetCounts {
  const counts = emptyAssetCounts()
  const look: Record<string, unknown>[] = [obj]
  for (const nest of NESTS) {
    const child = obj[nest]
    if (child && typeof child === 'object' && !Array.isArray(child)) look.push(child as Record<string, unknown>)
  }
  for (const source of look) {
    for (const [raw, value] of Object.entries(source)) {
      const field = COUNT_FIELDS.find((item) => item.names.includes(normKey(raw)))
      if (!field || counts[field.key] !== null) continue
      const n = asCount(value)
      if (n !== null) counts[field.key] = n
    }
  }
  return counts
}

function snapshotIdOf(obj: Record<string, unknown>): string | null {
  const id = typeof obj.id === 'string' ? obj.id : typeof obj._id === 'string' ? obj._id : ''
  return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : null
}

function snapshotNameOf(obj: Record<string, unknown>): string {
  if (typeof obj.name === 'string' && obj.name.trim()) return obj.name.trim()
  if (typeof obj.title === 'string' && obj.title.trim()) return obj.title.trim()
  return ''
}

/** The push-status document lists asset type names. It is not a snapshot. */
function isPushDocument(obj: Record<string, unknown>): boolean {
  return typeof obj.status === 'string' && typeof obj.locationId === 'string' && !snapshotNameOf(obj)
}

function countsKnown(counts: AssetCounts): boolean {
  return (Object.keys(counts) as (keyof AssetCounts)[]).some((key) => counts[key] !== null)
}

function mergeCounts(prev: AssetCounts, next: AssetCounts, preferNext: boolean): AssetCounts {
  const out = { ...prev }
  for (const key of Object.keys(out) as (keyof AssetCounts)[]) {
    if (next[key] === null) continue
    if (out[key] === null || preferNext) out[key] = next[key]
  }
  return out
}

export function mergeSnapshotRows(rows: SnapshotRow[]): SnapshotRow[] {
  const byId = new Map<string, SnapshotRow>()
  for (const row of rows) {
    const prev = byId.get(row.id)
    if (!prev) {
      byId.set(row.id, row)
      continue
    }
    const preferNext = row.source.includes(row.id) && !prev.source.includes(prev.id)
    byId.set(row.id, {
      id: row.id,
      name: row.name || prev.name,
      type: row.type || prev.type,
      source: preferNext ? row.source : prev.source,
      counts: mergeCounts(prev.counts, row.counts, preferNext || (!countsKnown(prev.counts) && countsKnown(row.counts))),
    })
  }
  return [...byId.values()]
}

/** Every snapshot object in a list or detail payload. */
export function readSnapshotCatalog(body: unknown, source: string): SnapshotRow[] {
  const rows: SnapshotRow[] = []
  const seen = new Set<unknown>()
  const walk = (node: unknown, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 8 || seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    const obj = node as Record<string, unknown>
    if (!isPushDocument(obj)) {
      const id = snapshotIdOf(obj)
      const name = snapshotNameOf(obj)
      if (id && name) {
        const type = typeof obj.type === 'string' ? obj.type : typeof obj.snapshotType === 'string' ? obj.snapshotType : ''
        rows.push({ id, name, type, source, counts: readCounts(obj) })
      }
    }
    for (const value of Object.values(obj)) walk(value, depth + 1)
  }
  walk(body, 0)
  return mergeSnapshotRows(rows)
}

export function snapshotCatalogLines(rows: SnapshotRow[]): string[] {
  if (!rows.length) return ['Snapshot diagnostic found no snapshots in the page JSON.']
  const lines = [`Snapshot diagnostic found ${rows.length} snapshot${rows.length === 1 ? '' : 's'}.`]
  for (const row of rows) {
    lines.push(`Snapshot ${row.id} | ${row.name} | type=${row.type || '(none)'} | ${describeAssetCounts(row.counts)} | ${row.source}`)
  }
  const hint = duplicateNameHint(rows)
  if (hint) lines.push(hint)
  return lines
}

export function duplicateNameHint(rows: SnapshotRow[]): string {
  const groups = new Map<string, SnapshotRow[]>()
  for (const row of rows) {
    const key = row.name.trim().toLowerCase()
    if (!key) continue
    const list = groups.get(key) || []
    list.push(row)
    groups.set(key, list)
  }
  const lines: string[] = []
  for (const list of groups.values()) {
    if (list.length < 2) continue
    const bits = list.map((row) => `${row.id} (${describeAssetCounts(row.counts)})`)
    lines.push(`More than one snapshot is named "${list[0].name}": ${bits.join('; ')}.`)
  }
  return lines.join(' ')
}

export function configuredSnapshotHint(rows: SnapshotRow[], id: string, name: string): string {
  if (!rows.length) return ''
  const row = rows.find((item) => item.id === id)
  if (!row) return `Configured snapshot ${id} was not in the diagnostic list.`
  const empty = (Object.keys(row.counts) as (keyof AssetCounts)[]).every((key) => row.counts[key] === null || row.counts[key] === 0)
  const richer = rows.filter(
    (item) =>
      item.id !== id &&
      item.name.trim().toLowerCase() === name.trim().toLowerCase() &&
      (['pipelines', 'workflows', 'funnels'] as const).some((key) => (item.counts[key] ?? 0) > 0),
  )
  if (empty && richer.length) {
    return `Configured snapshot ${id} ("${row.name}") asset counts are zero. Other "${name}" ids with assets: ${richer.map((item) => item.id).join(', ')}.`
  }
  if (empty) return `Configured snapshot ${id} ("${row.name}") has no pipelines, workflows, funnels, custom fields, or tags in the snapshot JSON.`
  return `Configured snapshot ${id} ("${row.name}") source ${describeAssetCounts(row.counts)}.`
}

export function sourceCountsFor(rows: SnapshotRow[], id: string): AssetCounts | null {
  const row = rows.find((item) => item.id === id)
  if (!row || !countsKnown(row.counts)) return null
  return row.counts
}

const DELETE_OR_ALL = /delete|remove snapshot|remove location|destroy|select all|all sub-accounts|all locations|all accounts/i

export function isUnsafeSnapshotControl(label: string): boolean {
  return DELETE_OR_ALL.test(label) || /add sub-account|create sub-account|create location|add manually|new sub-account|create account/i.test(label)
}

/** The action-menu item that pushes into an existing sub-account. Delete and create are never returned. */
export function chooseSnapshotMenuAction(labels: string[]): { ok: true; label: string } | { ok: false; reason: string } {
  const safe = labels.map((label) => label.replace(/\s+/g, ' ').trim()).filter((label) => label && !isUnsafeSnapshotControl(label))
  const push = safe.filter((label) => /push|load into|load snapshot|apply snapshot|push snapshot|push to/i.test(label))
  if (push.length === 1) return { ok: true, label: push[0] }
  const shown = `Visible menu: ${visibleControls(labels)}.`
  if (!push.length) return { ok: false, reason: `No push or load item in the snapshot menu. ${shown} Nothing was clicked.` }
  const existing = push.filter((label) => /existing|sub-?account|location/i.test(label) && !/all\b/i.test(label))
  if (existing.length === 1) return { ok: true, label: existing[0] }
  return { ok: false, reason: `Several push actions, so none was clicked. ${shown}` }
}

function normName(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

/** Exact location name, or the same name plus a trailing id or city. A longer business name is not a match. */
export function locationOptionMatches(option: string, locationId: string, locationName: string): boolean {
  const text = option.replace(/\s+/g, ' ').trim()
  const lower = text.toLowerCase()
  if (locationId && lower.includes(locationId.toLowerCase())) return true
  const name = normName(locationName)
  if (!name) return false
  const optionName = normName(text)
  if (optionName === name) return true
  if (!optionName.startsWith(name)) return false
  const rest = optionName.slice(name.length)
  return /^(\s*[|(—–-]|\s*\()/.test(rest)
}

export function chooseLocationTarget(
  options: string[],
  locationId: string,
  locationName: string,
): { ok: true; label: string } | { ok: false; reason: string } {
  const matches = options.filter((option) => locationOptionMatches(option, locationId, locationName))
  if (matches.length === 1) return { ok: true, label: matches[0] }
  const shown = `Visible locations: ${visibleControls(options)}.`
  if (!matches.length) {
    return { ok: false, reason: `No location matched ${locationName || locationId}. ${shown} Nothing was pushed.` }
  }
  return { ok: false, reason: `Several locations matched ${locationName || locationId}. ${shown} Nothing was pushed.` }
}

export function overwriteControl(
  checks: { text: string; checked: boolean }[],
  buttons: string[],
): { label: string; alreadyOn: boolean } | null {
  const check = checks.find((item) => /overwrite|override|replace existing/i.test(item.text) && !/skip|do not|don't/i.test(item.text))
  if (check) return { label: check.text, alreadyOn: check.checked }
  const button = buttons.find((label) => /overwrite|override existing|replace existing/i.test(label) && !isUnsafeSnapshotControl(label))
  if (button) return { label: button, alreadyOn: false }
  return null
}

/** The button that finishes the push. Next only advances a wizard. */
export function confirmPushControl(labels: string[]): { label: string; finishes: boolean } | null {
  const safe = labels.map((label) => label.replace(/\s+/g, ' ').trim()).filter((label) => label && !isUnsafeSnapshotControl(label))
  const rank: { pattern: RegExp; finishes: boolean }[] = [
    { pattern: /^(push snapshot|push to sub-accounts?|load snapshot|load into( existing)?( sub-accounts?)?)$/i, finishes: true },
    { pattern: /^(push|load|proceed|confirm|apply|import)$/i, finishes: true },
    { pattern: /^(next|continue)$/i, finishes: false },
  ]
  for (const item of rank) {
    const hit = safe.find((label) => item.pattern.test(label))
    if (hit) return { label: hit, finishes: item.finishes }
  }
  return null
}
