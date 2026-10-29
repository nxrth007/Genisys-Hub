/**
 * Provider-neutral matching of unlinked Hub clients to CRM sub-accounts
 * (GHL locations). Pure functions only: no DB, no network.
 *
 * Score per (client, location):
 *   business name exact            +60   (else token overlap scaled up to +40)
 *   first name vs contact/intake   +15
 *   phone (E.164) match            +25
 *   email match                    +25
 * Auto-link only when best >= 80 AND it leads the next-best by >= 20, and
 * the location's name isn't shared by another location. Everything else
 * scoring >= 50 is "needs review"; never auto-linked.
 */

export type MatchClient = {
  id: string
  name: string
  ghlLocationId?: string | null
  contactName?: string | null
  intakeName?: string | null
  intakeBusiness?: string | null
  phones?: (string | null | undefined)[]
  emails?: (string | null | undefined)[]
}

export type MatchLocation = { id: string; name: string; phone?: string | null; email?: string | null }

export type ScoredPair = { clientId: string; locationId: string; locationName: string; score: number; reasons: string[] }

export type MatchResult = {
  autoLinks: ScoredPair[]
  needsReview: (ScoredPair & { why: string })[]
  skipped: { denied: string[]; linkedLocations: number; linkedClients: number }
}

export const AUTO_LINK_MIN = 80
export const AUTO_LINK_LEAD = 20
export const REVIEW_MIN = 50

const SUFFIXES = new Set(['llc', 'inc', 'co', 'corp', 'ltd'])
const DENYLIST = ['lead genisys', 'master snapshot', 'trustware', 'out the vault']

/** Lowercase, '&'->'and', strip punctuation and LLC/INC/CO/CORP/LTD, collapse spaces. */
export function normalizeText(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t && !SUFFIXES.has(t))
    .join(' ')
    .trim()
}

/** Split "First: Business" on the first ':'; no ':' means business only. */
export function parseLocationName(name: string): { firstName: string | null; business: string } {
  const i = name.indexOf(':')
  if (i < 0) return { firstName: null, business: normalizeText(name) }
  const first = normalizeText(name.slice(0, i))
  return { firstName: first || null, business: normalizeText(name.slice(i + 1)) }
}

export function normalizePhone(p: string | null | undefined): string | null {
  const d = (p ?? '').replace(/\D/g, '')
  if (d.length === 10) return `+1${d}`
  if (d.length === 11 && d.startsWith('1')) return `+${d}`
  if (d.length > 11 && d.length <= 15) return `+${d}`
  return null
}

export function normalizeEmail(e: string | null | undefined): string | null {
  const v = (e ?? '').trim().toLowerCase()
  return v.includes('@') ? v : null
}

export function isDeniedName(name: string): boolean {
  const n = normalizeText(name)
  return DENYLIST.some((d) => n === d || n.startsWith(`${d} `) || n.includes(d))
}

function firstToken(s: string | null | undefined): string | null {
  return normalizeText(s).split(' ')[0] || null
}

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(a.split(' ').filter(Boolean))
  const tb = new Set(b.split(' ').filter(Boolean))
  if (!ta.size || !tb.size) return 0
  let common = 0
  for (const t of ta) if (tb.has(t)) common++
  return common / Math.max(ta.size, tb.size)
}

export function scorePair(client: MatchClient, location: MatchLocation): { score: number; reasons: string[] } {
  const loc = parseLocationName(location.name)
  const reasons: string[] = []
  let score = 0

  const businesses = [client.name, client.intakeBusiness].map(normalizeText).filter(Boolean)
  if (loc.business && businesses.includes(loc.business)) {
    score += 60
    reasons.push('business name exact (+60)')
  } else if (loc.business) {
    const best = Math.max(0, ...businesses.map((b) => tokenOverlap(b, loc.business)))
    const pts = Math.round(best * 40)
    if (pts > 0) {
      score += pts
      reasons.push(`business name overlap ${Math.round(best * 100)}% (+${pts})`)
    }
  }

  if (loc.firstName) {
    const firsts = [client.contactName, client.intakeName].map(firstToken).filter(Boolean)
    if (firsts.includes(loc.firstName.split(' ')[0])) {
      score += 15
      reasons.push('first name match (+15)')
    }
  }

  const lp = normalizePhone(location.phone)
  if (lp && (client.phones ?? []).some((p) => normalizePhone(p) === lp)) {
    score += 25
    reasons.push('phone match (+25)')
  }
  const le = normalizeEmail(location.email)
  if (le && (client.emails ?? []).some((e) => normalizeEmail(e) === le)) {
    score += 25
    reasons.push('email match (+25)')
  }
  return { score, reasons }
}

/**
 * @param rejected pairs (`${clientId}:${locationId}`) never to suggest again.
 */
export function matchSubaccounts(
  clients: MatchClient[],
  locations: MatchLocation[],
  opts: { linkedLocationIds?: Iterable<string>; rejected?: Iterable<string> } = {},
): MatchResult {
  const linked = new Set(opts.linkedLocationIds ?? [])
  for (const c of clients) if (c.ghlLocationId) linked.add(c.ghlLocationId)
  const rejected = new Set(opts.rejected ?? [])
  const denied: string[] = []
  const open = locations.filter((l) => {
    if (linked.has(l.id)) return false
    if (isDeniedName(l.name)) {
      denied.push(l.name)
      return false
    }
    return true
  })
  const nameCount = new Map<string, number>()
  for (const l of open) {
    const k = normalizeText(l.name)
    nameCount.set(k, (nameCount.get(k) ?? 0) + 1)
  }
  const unlinked = clients.filter((c) => !c.ghlLocationId)

  const autoLinks: ScoredPair[] = []
  const needsReview: (ScoredPair & { why: string })[] = []
  for (const c of unlinked) {
    if (isDeniedName(c.name)) continue
    const scored = open
      .filter((l) => !rejected.has(`${c.id}:${l.id}`))
      .map((l) => ({ clientId: c.id, locationId: l.id, locationName: l.name, ...scorePair(c, l) }))
      .sort((a, b) => b.score - a.score)
    const [best, next] = scored
    if (!best || best.score < REVIEW_MIN) continue
    const lead = best.score - (next?.score ?? 0)
    const dupName = (nameCount.get(normalizeText(best.locationName)) ?? 0) > 1
    if (dupName) {
      needsReview.push({ ...best, why: 'several sub-accounts share this name' })
      for (const o of scored.slice(1)) if (o.score === best.score) needsReview.push({ ...o, why: 'several sub-accounts share this name' })
    } else if (best.score >= AUTO_LINK_MIN && lead >= AUTO_LINK_LEAD) autoLinks.push(best)
    else if (best.score >= AUTO_LINK_MIN) needsReview.push({ ...best, why: `only ${lead} points ahead of the next match` })
    else needsReview.push({ ...best, why: `score ${best.score} below ${AUTO_LINK_MIN}` })
  }

  // One location claimed by two clients: neither gets it automatically.
  const claims = new Map<string, number>()
  for (const a of autoLinks) claims.set(a.locationId, (claims.get(a.locationId) ?? 0) + 1)
  const finalLinks = autoLinks.filter((a) => {
    if ((claims.get(a.locationId) ?? 0) < 2) return true
    needsReview.push({ ...a, why: 'another client matches this sub-account too' })
    return false
  })
  return { autoLinks: finalLinks, needsReview, skipped: { denied, linkedLocations: linked.size, linkedClients: clients.length - unlinked.length } }
}
