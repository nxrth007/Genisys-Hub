import { prisma } from '@/lib/prisma'
import { API_VERSION, BASE_URL, GHL_AGENCY_KEY_VAULT_NAME, decodeJwtPayload } from '@/lib/ghl'
import { getAgencyContext } from '@/lib/ghl-agency'
import { getSecretByName } from '@/lib/vault-service'
import { AUTOMATION_VALUE_DEFS, type AutomationInputs } from '@/lib/automation-copy'

/**
 * The Automation Copy board's details as custom values in the client's
 * GHL sub-account, so the snapshot's workflows can say
 * {{custom_values.owner_first_name}} instead of a typed-in name.
 *
 * Custom values can be written over the API on the $297 plan, but which
 * key GHL accepts for them isn't documented: the agency key may work for
 * every sub-account, or each sub-account may need its own key in the
 * Vault. So every call tries the client's own sub-account key first (a
 * Vault entry tagged `ghl` whose location is this client's), then the
 * agency key, and reports what each one could do.
 *
 * The workflows list is read too: GHL's API gives only names and status,
 * not steps, but it shows which base automations a sub-account has.
 */

export type Access = {
  source: 'sub-account key' | 'agency key'
  /** The Vault entry the key came from. */
  label: string
  token: string
}

export type AccessReport = {
  source: Access['source']
  label: string
  customValues: { ok: boolean; detail: string }
  workflows: { ok: boolean; detail: string }
}

export type GhlValueRow = {
  key: string
  name: string
  input: keyof AutomationInputs
  /** What the board says it should be. */
  hub: string
  /** What the sub-account has, if the value exists there. */
  ghl: { id: string; fieldKey: string; value: string } | null
}

export type GhlAutomationStatus =
  | { linked: false; reason: string }
  | {
      linked: true
      locationId: string
      subaccountUrl: string | null
      profile: { name: string; phone: string; email: string; website: string } | null
      access: AccessReport[]
      /** Which key the Hub writes with, or null when none can. */
      using: { source: Access['source']; label: string } | null
      values: GhlValueRow[]
      /** Custom values in the sub-account that aren't ours, by name. */
      otherValues: { name: string; fieldKey: string }[]
      workflows: { name: string; status: string }[] | null
      /** Keys the Hub couldn't even load. */
      notes: string[]
    }

class GhlCallError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message)
  }
}

async function call<T = Record<string, unknown>>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Version: API_VERSION,
        Accept: 'application/json',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    })
  } catch (err) {
    throw new GhlCallError(`couldn't reach GHL (${err instanceof Error ? err.message : String(err)})`, null)
  }
  const text = await res.text()
  if (!res.ok) {
    let msg = text.slice(0, 200)
    try {
      const j = JSON.parse(text) as { message?: unknown; error?: unknown }
      const m = Array.isArray(j.message) ? j.message.join('; ') : j.message ?? j.error
      if (typeof m === 'string' && m) msg = m
    } catch {
      // keep the raw text
    }
    throw new GhlCallError(`HTTP ${res.status}: ${msg || 'no details'}`, res.status)
  }
  return (text ? JSON.parse(text) : {}) as T
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** GHL's "not authorized for this scope", in words that say what to do. */
function scopeHint(a: Access, msg: string, permissions: string): string {
  if (!/not authorized for this scope/i.test(msg)) return msg
  return a.source === 'agency key'
    ? `${msg} (agency keys can't be given this permission; a key from the sub-account is needed)`
    : `${msg} Tick ${permissions} on this key in GHL (sub-account → Settings → Private Integrations → the key → Edit).`
}

export type RawValue = { id: string; name: string; fieldKey: string; value: string }

export async function readValues(a: Access, locationId: string): Promise<RawValue[]> {
  const res = await call<{ customValues?: Array<Record<string, unknown>> }>(a.token, `/locations/${locationId}/customValues`)
  return (res.customValues ?? []).map((v) => ({
    id: String(v.id ?? ''),
    name: String(v.name ?? ''),
    fieldKey: String(v.fieldKey ?? ''),
    value: typeof v.value === 'string' ? v.value : '',
  }))
}

async function readWorkflows(a: Access, locationId: string): Promise<{ name: string; status: string }[]> {
  const res = await call<{ workflows?: Array<Record<string, unknown>> }>(a.token, `/workflows/?locationId=${encodeURIComponent(locationId)}`)
  return (res.workflows ?? [])
    .map((w) => ({ name: String(w.name ?? ''), status: String(w.status ?? '') }))
    .sort((x, y) => x.name.localeCompare(y.name))
}

/** Words in a business name that don't identify it ("Luxama Services" → luxama). */
const GENERIC_WORDS = new Set(
  [
    'the and of a llc inc co company services service construction contracting contractors contractor solutions pros pro group',
    'home homes ghl token key sub account subaccount genisys api private integration',
    // Trade words two clients can share ("Junior Concrete", "C&J Concrete Coatings").
    'concrete coatings coating roofing roof painting paint lawn care pest fence fencing driveway cleaning masonry brick',
  ]
    .join(' ')
    .split(' '),
)
export const nameWords = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w))

/** "locationId=abc…", or (like resolveToken in ghl.ts) a description that is just the id. */
export const locationIn = (description: string | null): string | null => {
  const d = description?.trim() ?? ''
  return d.match(/location[_-]?id\s*[=:]\s*([A-Za-z0-9_-]+)/i)?.[1] ?? (/^[A-Za-z0-9_-]{15,40}$/.test(d) ? d : null)
}

/**
 * The client's own sub-account key, then the agency key.
 *
 * A Vault entry counts as this client's key when its description names
 * this sub-account (locationId=…), its key is a JWT for it, or (with no
 * location given) its name or client=… hint names this client. The `ghl`
 * tag isn't required here: the match is what matters, and every entry
 * looked at is reported so a near miss is visible on the board.
 */
export async function subAccountKeys(locationId: string, clientNames: string[]): Promise<{ keys: Access[]; problems: string[] }> {
  const keys: Access[] = []
  const problems: string[] = []
  const wanted = new Set(clientNames.flatMap(nameWords))
  try {
    const entries = await prisma.vaultEntry.findMany({ select: { name: true, description: true, tags: true }, orderBy: { name: 'asc' } })
    for (const e of entries) {
      if (e.name.trim().toLowerCase() === GHL_AGENCY_KEY_VAULT_NAME.toLowerCase()) continue
      const tagged = e.tags.some((t) => t.trim().toLowerCase() === 'ghl')
      const hint = e.description?.match(/client\s*[=:]\s*([^\n;]+)/i)?.[1] ?? ''
      const named = [...nameWords(e.name), ...nameWords(hint)].some((w) => wanted.has(w))
      const looksGhl = tagged || /\b(ghl|highlevel|high level|go high level|leadconnector)\b/i.test(e.name)
      const declared = locationIn(e.description)
      if (declared && declared !== locationId) continue
      // Only open entries that point at this sub-account or name this client: every read is logged in the Vault.
      if (declared !== locationId && !(named && looksGhl)) continue
      let token: string
      try {
        token = (await getSecretByName(e.name)).trim()
      } catch (err) {
        if (declared || named) problems.push(`Couldn't read the Vault entry "${e.name}": ${reason(err)}`)
        continue
      }
      const jwtLocation = decodeJwtPayload(token).locationId
      if (jwtLocation && jwtLocation !== locationId) continue
      const matched = declared === locationId || jwtLocation === locationId
      if (!matched && !named) continue
      keys.push({ source: 'sub-account key', label: e.name, token })
      if (!matched) problems.push(`"${e.name}" has no locationId in its Vault description; used because its name matches this client.`)
      if (!tagged) problems.push(`"${e.name}" isn't tagged ghl in the Vault; used because it matches this sub-account. Tag it ghl and client so the rest of the Hub sees it.`)
    }
    if (!keys.length) {
      problems.push(
        `No Vault entry matched this sub-account. Give the key's entry the description "locationId=${locationId}", or name it after the business.`,
      )
    }
  } catch (err) {
    problems.push(`Couldn't read the Vault: ${reason(err)}`)
  }
  return { keys, problems }
}

async function accessFor(locationId: string, clientNames: string[]): Promise<{ keys: Access[]; problems: string[] }> {
  const { keys, problems } = await subAccountKeys(locationId, clientNames)
  try {
    const ctx = await getAgencyContext()
    keys.push({ source: 'agency key', label: GHL_AGENCY_KEY_VAULT_NAME, token: ctx.token })
  } catch (err) {
    problems.push(`Agency key unavailable: ${reason(err)}`)
  }
  return { keys, problems }
}

async function linkedClient(clientId: string) {
  return prisma.client.findUnique({ where: { id: clientId }, select: { id: true, name: true, ghlLocationId: true, ghlSubaccountUrl: true } })
}

function rows(inputs: AutomationInputs, existing: RawValue[]): { values: GhlValueRow[]; otherValues: { name: string; fieldKey: string }[] } {
  const byName = new Map(existing.map((v) => [v.name.trim().toLowerCase(), v]))
  const ours = new Set(AUTOMATION_VALUE_DEFS.map((d) => d.name.toLowerCase()))
  return {
    values: AUTOMATION_VALUE_DEFS.map((d) => {
      const g = byName.get(d.name.toLowerCase())
      return { key: d.key, name: d.name, input: d.input, hub: inputs[d.input].trim(), ghl: g ? { id: g.id, fieldKey: g.fieldKey, value: g.value } : null }
    }),
    otherValues: existing.filter((v) => !ours.has(v.name.trim().toLowerCase())).map((v) => ({ name: v.name, fieldKey: v.fieldKey })),
  }
}

/** Read-only: what each key can do in the client's sub-account, its custom values and its workflows. */
export async function ghlAutomationStatus(clientId: string, inputs: AutomationInputs): Promise<GhlAutomationStatus> {
  const client = await linkedClient(clientId)
  if (!client) return { linked: false, reason: 'Client not found.' }
  if (!client.ghlLocationId) return { linked: false, reason: 'This client isn’t linked to a GHL sub-account in the Hub yet.' }
  const locationId = client.ghlLocationId

  const { keys, problems } = await accessFor(locationId, [client.name])
  const access: AccessReport[] = []
  let using: Access | null = null
  let existing: RawValue[] | null = null
  let workflows: { name: string; status: string }[] | null = null

  for (const a of keys) {
    const report: AccessReport = {
      source: a.source,
      label: a.label,
      customValues: { ok: false, detail: '' },
      workflows: { ok: false, detail: '' },
    }
    try {
      const vals = await readValues(a, locationId)
      report.customValues = { ok: true, detail: `${vals.length} custom value${vals.length === 1 ? '' : 's'}` }
      if (!using) {
        using = a
        existing = vals
      }
    } catch (err) {
      report.customValues = { ok: false, detail: scopeHint(a, reason(err), 'View Custom Values and Edit Custom Values') }
    }
    try {
      const wf = await readWorkflows(a, locationId)
      report.workflows = { ok: true, detail: `${wf.length} workflow${wf.length === 1 ? '' : 's'}` }
      workflows ??= wf
    } catch (err) {
      report.workflows = { ok: false, detail: scopeHint(a, reason(err), 'View Workflows') }
    }
    access.push(report)
  }

  // The business profile, for comparing with the board. The agency key can always read it.
  let profile: { name: string; phone: string; email: string; website: string } | null = null
  for (const a of keys) {
    try {
      const res = await call<{ location?: Record<string, unknown> }>(a.token, `/locations/${locationId}`)
      const l = res.location ?? {}
      const s = (k: string) => (typeof l[k] === 'string' ? (l[k] as string) : '')
      profile = { name: s('name'), phone: s('phone'), email: s('email'), website: s('website') }
      break
    } catch {
      // try the next key
    }
  }

  const { values, otherValues } = rows(inputs, existing ?? [])
  const usingAccess = using as Access | null
  return {
    linked: true,
    locationId,
    subaccountUrl: client.ghlSubaccountUrl,
    profile,
    access,
    using: usingAccess ? { source: usingAccess.source, label: usingAccess.label } : null,
    values,
    otherValues,
    workflows,
    notes: problems,
  }
}

export type PushResult = {
  ok: boolean
  /** Why nothing was written, when ok is false and no row was tried. */
  error: string | null
  results: { name: string; action: 'created' | 'updated' | 'unchanged' | 'skipped' | 'failed'; detail: string }[]
  status: GhlAutomationStatus
}

/**
 * Write the board's details into the sub-account as custom values: update
 * a value with the same name, create it when missing (GHL has no upsert,
 * and a second value with the same name would fight over one token).
 * Blank details are skipped, never written as empty.
 */
export async function pushAutomationValues(clientId: string, inputs: AutomationInputs): Promise<PushResult> {
  const client = await linkedClient(clientId)
  if (!client?.ghlLocationId) {
    const status = await ghlAutomationStatus(clientId, inputs)
    return { ok: false, error: 'This client isn’t linked to a GHL sub-account in the Hub yet.', results: [], status }
  }
  const locationId = client.ghlLocationId
  const { keys } = await accessFor(locationId, [client.name])
  let access: Access | null = null
  let existing: RawValue[] = []
  for (const a of keys) {
    try {
      existing = await readValues(a, locationId)
      access = a
      break
    } catch {
      // try the next key
    }
  }
  if (!access) {
    const status = await ghlAutomationStatus(clientId, inputs)
    return { ok: false, error: 'No key the Hub has can read this sub-account’s custom values. See the connection check for what GHL said.', results: [], status }
  }

  const byName = new Map(existing.map((v) => [v.name.trim().toLowerCase(), v]))
  const results: PushResult['results'] = []
  for (const d of AUTOMATION_VALUE_DEFS) {
    const value = inputs[d.input].trim()
    if (!value) {
      results.push({ name: d.name, action: 'skipped', detail: 'Blank on the board' })
      continue
    }
    const current = byName.get(d.name.toLowerCase())
    try {
      if (current && current.value === value) {
        results.push({ name: d.name, action: 'unchanged', detail: current.fieldKey })
      } else if (current) {
        await call(access.token, `/locations/${locationId}/customValues/${current.id}`, { method: 'PUT', body: { name: d.name, value } })
        results.push({ name: d.name, action: 'updated', detail: current.fieldKey })
      } else {
        const res = await call<{ customValue?: { fieldKey?: string } }>(access.token, `/locations/${locationId}/customValues`, {
          method: 'POST',
          body: { name: d.name, value },
        })
        results.push({ name: d.name, action: 'created', detail: res.customValue?.fieldKey ?? '' })
      }
    } catch (err) {
      results.push({ name: d.name, action: 'failed', detail: reason(err) })
    }
  }
  const status = await ghlAutomationStatus(clientId, inputs)
  return { ok: results.every((r) => r.action !== 'failed'), error: null, results, status }
}
