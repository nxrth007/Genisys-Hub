/**
 * Which GitHub repo (and which live site) belongs to which client — the
 * Hub's best guess, so the Clients page can show the likely one in green.
 *
 * Names are compared squashed ("C&J Concrete Coatings LLC" → candj…),
 * after dropping the trade words two clients can share, so "Calvins
 * Construction" and "A1M Construction" don't look alike just because both
 * build things. Shared by the browser (Repo column) and the server (Site
 * suggestions), so no server imports here.
 */

/** Trade and filler words removed from squashed names before comparing (longest first, so "paintings" goes before "painting"). */
const FILLER = [
  'construction', 'contractors', 'contracting', 'contractor', 'maintenance', 'solutions', 'paintings', 'services',
  'painting', 'cleaning', 'concretes', 'concrete', 'coatings', 'driveway', 'roofing', 'masonry', 'company', 'fencing',
  'service', 'coating', 'homes',
].sort((a, b) => b.length - a.length)

/** "Jake's Property Maintenance LLC" → "jakesproperty"; "venturaclient" → "ventura". */
export function squashName(s: string | null | undefined): string {
  let t = (s ?? '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '')
    .replace(/^the(?=[a-z]{4})/, '')
    .replace(/(llc|inc|corp|client|website|site|app)$/, '')
  for (const w of FILLER) {
    // Never strip a name down to nothing: "Concrete Masonry" stays comparable.
    const next = t.split(w).join('')
    if (next.length >= 3) t = next
  }
  return t
}

function longestCommon(a: string, b: string): number {
  let best = 0
  const prev = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    let diag = 0
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0
      if (prev[j] > best) best = prev[j]
      diag = up
    }
  }
  return best
}

/** 0–1: how much two names look like the same business. */
export function nameScore(x: string | null | undefined, y: string | null | undefined): number {
  const a = squashName(x)
  const b = squashName(y)
  if (a.length < 3 || b.length < 3) return 0
  if (a === b) return 1
  const common = longestCommon(a, b)
  if (common < 5) return 0
  return (common / Math.min(a.length, b.length)) * 0.7 + (common / Math.max(a.length, b.length)) * 0.3
}

/** The identifying part of a domain or URL: "https://www.luxamaservices.org/" → "luxamaservices". */
export function domainLabel(v: string | null | undefined): string | null {
  const s = (v ?? '').trim().toLowerCase()
  if (!s || /\s/.test(s)) return null
  const host = s.includes('@') ? s.split('@')[1] : s.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0]
  if (!host || !host.includes('.')) return null
  const parts = host.replace(/^www\./, '').split('.')
  return parts.length >= 2 ? parts[parts.length - 2] : null
}

/** Mailbox providers: their domain says nothing about the business. */
const FREE_MAIL = new Set(['gmail', 'yahoo', 'hotmail', 'outlook', 'icloud', 'aol', 'live', 'msn', 'me', 'comcast', 'protonmail', 'proton', 'att', 'ymail', 'mail', 'share'])

export type MatchClient = {
  id: string
  name: string
  /** Owner names: Lovable projects are named after the owner ("Winy Luxama"). */
  people: (string | null | undefined)[]
  /** Domains, URLs or emails the client gave us or we set: the site, their own domain, their website. */
  addresses: (string | null | undefined)[]
  repoFullName: string | null
}

/** A Lovable project that's connected to GitHub (from the Lovable → GitHub watch). */
export type MatchProject = { name: string; repoFullName: string | null; clientId: string | null }

const words = (s: string | null | undefined) =>
  new Set(
    (s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((w) => w.length >= 2 && !['llc', 'inc', 'the', 'and', 'co', 'corp'].includes(w)),
  )

/** Every word of the shorter name in the longer, and at least two of them ("Robert Paul" ⊆ "Robert Paul Contracting, Inc"). */
function samePerson(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = words(a)
  const y = words(b)
  const [short, long] = x.size <= y.size ? [x, y] : [y, x]
  return short.size >= 2 && [...short].every((w) => long.has(w))
}

const repoName = (fullName: string) => fullName.split('/').pop() ?? fullName

/** How well a repo fits a client, and why. */
export function repoFit(c: MatchClient, fullName: string, projects: MatchProject[] = []): { score: number; why: string } {
  const repo = fullName.toLowerCase()
  for (const p of projects) {
    if (p.repoFullName?.toLowerCase() !== repo) continue
    if (p.clientId === c.id) return { score: 1, why: `Lovable project “${p.name}” is linked to this client` }
    if (c.people.some((n) => samePerson(n, p.name))) return { score: 0.95, why: `Lovable project “${p.name}” is named after the owner` }
  }
  const name = repoName(fullName)
  let best = { score: nameScore(name, c.name), why: 'Repo name matches the business name' }
  for (const a of c.addresses) {
    const label = domainLabel(a)
    if (!label || FREE_MAIL.has(label)) continue
    const s = nameScore(name, label)
    if (s > best.score) best = { score: s, why: `Repo name matches ${label}` }
  }
  return best
}

export const SUGGEST_MIN = 0.75

export type RepoSuggestion = { repo: string; why: string; score: number }

/**
 * The repo each client most likely lives in: the client's best repo, when
 * that repo's best client is this client too (so one repo is never offered
 * to two clients) and no other client already holds it.
 */
export function suggestReposForClients(
  clients: MatchClient[],
  repos: string[],
  projects: MatchProject[] = [],
): Map<string, RepoSuggestion> {
  const owner = new Map<string, string>()
  for (const c of clients) if (c.repoFullName) owner.set(c.repoFullName.toLowerCase(), c.id)
  const fits = new Map<string, { score: number; why: string }>()
  const key = (cid: string, r: string) => `${cid}\u0000${r.toLowerCase()}`
  for (const c of clients)
    for (const r of repos) {
      const held = owner.get(r.toLowerCase())
      if (held && held !== c.id) continue
      const f = repoFit(c, r, projects)
      if (f.score >= SUGGEST_MIN) fits.set(key(c.id, r), f)
    }
  const out = new Map<string, RepoSuggestion>()
  for (const c of clients) {
    let best: RepoSuggestion | null = null
    let tie = false
    for (const r of repos) {
      const f = fits.get(key(c.id, r))
      if (!f) continue
      if (!best || f.score > best.score) {
        best = { repo: r, ...f }
        tie = false
      } else if (f.score === best.score) tie = true
    }
    if (!best || tie) continue
    // Mutual: no other client fits this repo as well.
    const rival = clients.some((o) => o.id !== c.id && (fits.get(key(o.id, best!.repo))?.score ?? 0) >= best!.score)
    if (!rival) out.set(c.id, best)
  }
  return out
}
