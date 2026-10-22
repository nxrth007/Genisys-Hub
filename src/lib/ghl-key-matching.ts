import { prisma } from '@/lib/prisma'
import { API_VERSION, BASE_URL, GHL_AGENCY_KEY_VAULT_NAME, decodeJwtPayload } from '@/lib/ghl'
import { getAgencyContext, listAllLocations } from '@/lib/ghl-agency'
import { getSecretByName, updateEntry } from '@/lib/vault-service'
import { nameWords } from '@/lib/ghl-automation-values'

/**
 * Work out which client sub-account each GHL key in the Vault belongs to.
 *
 * A sub-account's Private Integration key (pit-…) doesn't say which
 * sub-account it's for, and the Vault entry is usually just named after the
 * client. So for every `ghl` entry with no location yet, this asks GHL:
 * the key is tried against the agency's client sub-accounts ("First:
 * Business"), likeliest first by name, until GHL accepts it. A match is
 * written back to the entry: `locationId=…; client=…` in the description
 * and the `client` tag, so the rest of the Hub (CRM, bookings) knows it's a
 * client's account and never one of ours. Nothing is written without GHL
 * accepting the key for that sub-account.
 */

export type KeyMatchResult = {
  matched: { entry: string; location: string; client: string | null }[]
  unmatched: { entry: string; reason: string }[]
  /** Entries already pointing at a sub-account (only their tag may have been added). */
  alreadySet: string[]
  error: string | null
}

const locationIn = (description: string | null) => description?.match(/location[_-]?id\s*[=:]\s*([A-Za-z0-9_-]+)/i)?.[1] ?? null
const businessPart = (n: string) => (n.includes(':') ? n.slice(n.indexOf(':') + 1) : n).trim()

/** Does GHL accept this key for this sub-account? 'scope' = the key reached GHL but lacks the permission to tell. */
async function accepts(token: string, locationId: string): Promise<'yes' | 'no' | 'scope'> {
  const tryPath = async (path: string): Promise<'yes' | 'no' | 'scope'> => {
    try {
      const res = await fetch(`${BASE_URL}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Version: API_VERSION, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) return 'yes'
      const text = await res.text()
      return /not authorized for this scope/i.test(text) ? 'scope' : 'no'
    } catch {
      return 'no'
    }
  }
  const values = await tryPath(`/locations/${locationId}/customValues`)
  if (values !== 'scope') return values
  // Missing the custom-values permission: the location itself may still say whose key it is.
  const loc = await tryPath(`/locations/${locationId}`)
  return loc === 'yes' ? 'yes' : 'scope'
}

export async function matchVaultKeys(userId: string): Promise<KeyMatchResult> {
  const result: KeyMatchResult = { matched: [], unmatched: [], alreadySet: [], error: null }
  let locations: { id: string; name: string }[]
  try {
    locations = (await listAllLocations(await getAgencyContext())).locations
      .map((l) => ({ id: l.id, name: l.name }))
      // Client sub-accounts are named "First: Business"; the agency's own aren't.
      .filter((l) => l.name.includes(':'))
  } catch (err) {
    return { ...result, error: `Couldn't list the agency's sub-accounts: ${err instanceof Error ? err.message : String(err)}` }
  }
  const clients = await prisma.client.findMany({ where: { ghlLocationId: { not: null } }, select: { name: true, ghlLocationId: true } })
  const clientAt = new Map(clients.map((c) => [c.ghlLocationId!, c.name]))
  const clientLocations = new Set(locations.map((l) => l.id))

  const entries = await prisma.vaultEntry.findMany({
    where: { tags: { has: 'ghl' } },
    select: { id: true, name: true, description: true, tags: true },
    orderBy: { name: 'asc' },
  })
  const claimed = new Set(entries.map((e) => locationIn(e.description)).filter((x): x is string => !!x))

  for (const e of entries) {
    if (e.name.trim().toLowerCase() === GHL_AGENCY_KEY_VAULT_NAME.toLowerCase()) continue
    const declared = locationIn(e.description)
    const tagged = e.tags.some((t) => ['client', 'clients', 'customer'].includes(t.trim().toLowerCase()))
    if (declared) {
      // Points at a client sub-account but isn't tagged as one: tag it.
      if (clientLocations.has(declared) && !tagged) await updateEntry(e.id, userId, { tags: [...e.tags, 'client'] })
      if (clientLocations.has(declared)) result.alreadySet.push(e.name)
      continue
    }
    let token: string
    try {
      token = (await getSecretByName(e.name)).trim()
    } catch (err) {
      result.unmatched.push({ entry: e.name, reason: `Couldn't read it: ${err instanceof Error ? err.message : String(err)}` })
      continue
    }
    if (decodeJwtPayload(token).locationId) continue // an older location token; it already says where it belongs

    // Likeliest sub-accounts first: shared name words, then the rest.
    const words = new Set(nameWords(e.name))
    const first = e.name.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
    const score = (l: { name: string }) =>
      nameWords(businessPart(l.name)).filter((w) => words.has(w)).length * 2 + (l.name.toLowerCase().startsWith(`${first}:`) ? 1 : 0)
    const candidates = locations.filter((l) => !claimed.has(l.id)).sort((a, b) => score(b) - score(a))

    let found: { id: string; name: string } | null = null
    let scopeOnly = false
    for (const l of candidates) {
      const r = await accepts(token, l.id)
      if (r === 'yes') {
        found = l
        break
      }
      // Keep going: a wrong sub-account can answer with the same error.
      if (r === 'scope') scopeOnly = true
    }
    if (!found) {
      result.unmatched.push({
        entry: e.name,
        reason: scopeOnly
          ? 'The key reached GHL but has neither View Custom Values nor View Locations ticked, so it can’t be placed. Tick them on the key in GHL.'
          : 'No client sub-account accepted this key (it may be one of Genisys’s own, or a typo in the key).',
      })
      continue
    }
    claimed.add(found.id)
    const client = clientAt.get(found.id) ?? null
    const line = `locationId=${found.id}; client=${client ?? businessPart(found.name)}`
    await updateEntry(e.id, userId, {
      description: [e.description?.trim(), line].filter(Boolean).join('\n'),
      tags: tagged ? e.tags : [...e.tags, 'client'],
    })
    result.matched.push({ entry: e.name, location: found.name, client })
  }
  return result
}
