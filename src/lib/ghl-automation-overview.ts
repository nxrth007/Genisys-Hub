import { prisma } from '@/lib/prisma'
import { getAgencyContext, listAllLocations } from '@/lib/ghl-agency'
import { AUTOMATION_VALUE_DEFS } from '@/lib/automation-copy'
import { boardInputs } from '@/lib/automation-copy-server'
import { nameWords, readValues, subAccountKeys } from '@/lib/ghl-automation-values'

/**
 * Every active client's standing for the GHL custom values, for the
 * Automation Copy list: which sub-account it's linked to (or which one its
 * name points at), whether a Vault key for that sub-account works, and how
 * many of the six values are there and match the board. Read-only.
 */

export type ClientGhlOverview = {
  id: string
  name: string
  linked: { locationId: string; name: string | null } | null
  /** An agency sub-account whose name matches this unlinked client, to confirm with one click. */
  proposal: { locationId: string; name: string } | null
  key: { label: string; ok: boolean; detail: string } | null
  values: { present: number; matching: number; total: number } | null
}

export type GhlOverview = { clients: ClientGhlOverview[]; agencyError: string | null }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
/** "Winy: Luxama Services" → "Luxama Services". */
const businessPart = (locationName: string) => (locationName.includes(':') ? locationName.slice(locationName.indexOf(':') + 1) : locationName).trim()

/** The one sub-account whose business name is this client's, or shares the most identifying words with it (no ties). */
export function proposeLocation(clientName: string, locations: { id: string; name: string }[]): { locationId: string; name: string } | null {
  const exact = locations.filter((l) => norm(businessPart(l.name)) === norm(clientName))
  if (exact.length === 1) return { locationId: exact[0].id, name: exact[0].name }
  const wanted = new Set(nameWords(clientName))
  if (!wanted.size) return null
  const scored = locations
    .map((l) => ({ l, score: nameWords(businessPart(l.name)).filter((w) => wanted.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
  if (!scored.length || (scored[1] && scored[1].score === scored[0].score)) return null
  return { locationId: scored[0].l.id, name: scored[0].l.name }
}

/** Run `fn` over `items` a few at a time (GHL rate-limits bursts). */
async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}

export async function ghlAutomationOverview(): Promise<GhlOverview> {
  const clients = await prisma.client.findMany({
    where: { archivedAt: null },
    select: { id: true, name: true, ghlLocationId: true },
  })
  clients.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))

  let locations: { id: string; name: string }[] = []
  let agencyError: string | null = null
  try {
    locations = (await listAllLocations(await getAgencyContext())).locations.map((l) => ({ id: l.id, name: l.name }))
  } catch (err) {
    agencyError = err instanceof Error ? err.message : String(err)
  }
  const nameOf = new Map(locations.map((l) => [l.id, l.name]))
  const taken = new Set(clients.map((c) => c.ghlLocationId).filter((x): x is string => !!x))
  // Client sub-accounts look like "First: Business"; the agency's own don't.
  const free = locations.filter((l) => !taken.has(l.id) && l.name.includes(':'))

  const rows = await pool(clients, 4, async (c): Promise<ClientGhlOverview> => {
    const base = { id: c.id, name: c.name }
    if (!c.ghlLocationId) {
      return { ...base, linked: null, proposal: proposeLocation(c.name, free), key: null, values: null }
    }
    const linked = { locationId: c.ghlLocationId, name: nameOf.get(c.ghlLocationId) ?? null }
    const names = [c.name, ...(linked.name ? [businessPart(linked.name)] : [])]
    const { keys } = await subAccountKeys(c.ghlLocationId, names)
    if (!keys.length) {
      return { ...base, linked, proposal: null, key: { label: '', ok: false, detail: 'No Vault key for this sub-account' }, values: null }
    }
    let lastError = ''
    for (const k of keys) {
      try {
        const existing = await readValues(k, c.ghlLocationId)
        const inputs = await boardInputs(c.id)
        const byName = new Map(existing.map((v) => [v.name.trim().toLowerCase(), v.value]))
        let present = 0
        let matching = 0
        for (const d of AUTOMATION_VALUE_DEFS) {
          const v = byName.get(d.name.toLowerCase())
          if (v === undefined) continue
          present++
          if (inputs && v === inputs[d.input].trim()) matching++
        }
        return {
          ...base,
          linked,
          proposal: null,
          key: { label: k.label, ok: true, detail: 'Works' },
          values: { present, matching, total: AUTOMATION_VALUE_DEFS.length },
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      }
    }
    return { ...base, linked, proposal: null, key: { label: keys.map((k) => k.label).join(', '), ok: false, detail: lastError }, values: null }
  })
  return { clients: rows, agencyError }
}
