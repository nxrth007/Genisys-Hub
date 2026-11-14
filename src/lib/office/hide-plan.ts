/**
 * Hiding an Office request or question from your own view (Alex, 2026-11-14: "hide them from the
 * main office view", without deciding anything). Hiding never answers: the bot keeps waiting, the
 * question stays answerable, and it's one click to show it again. A hidden item stays hidden while
 * it says the same thing; when the bot raises it again with something new (another failure, the next
 * step of a question), it shows again. Each person hides for themselves.
 *
 * Pure (tests load it): src/lib/office/hidden.ts stores it, the Office view filters with it.
 */

/** Per item id: what it said when it was hidden, and when. */
export type HiddenMap = Record<string, { sig: string; at: string }>

/** A request (stuck or failed) is the same one while its text is. */
export const requestSig = (r: { text: string }): string => `r|${r.text}`

/** A question is the same one while it asks the same thing at the same step. */
export const approvalSig = (a: { stage: string; question: string }): string => `a|${a.stage}|${a.question}`

export const isHidden = (hidden: HiddenMap, id: string, sig: string): boolean => hidden[id]?.sig === sig

/** Hidden entries are forgotten after this long, so the map stays small. */
export const HIDE_KEEP_MS = 60 * 86_400_000
const MAX_ENTRIES = 500

/** The map after hiding (or showing again) one item; old entries drop off. */
export function nextHidden(prev: HiddenMap, change: { id: string; sig: string; hidden: boolean }, now = new Date()): HiddenMap {
  const cutoff = now.getTime() - HIDE_KEEP_MS
  const kept = Object.entries(prev).filter(([id, v]) => id !== change.id && Date.parse(v.at) >= cutoff)
  if (change.hidden) kept.push([change.id, { sig: change.sig, at: now.toISOString() }])
  return Object.fromEntries(kept.slice(-MAX_ENTRIES))
}

/** What's stored, read safely (anything malformed is dropped). */
export function readHiddenMap(raw: string | null | undefined): HiddenMap {
  let v: unknown
  try {
    v = raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: HiddenMap = {}
  for (const [id, e] of Object.entries(v as Record<string, unknown>)) {
    const x = (e ?? {}) as { sig?: unknown; at?: unknown }
    if (id && typeof x.sig === 'string' && typeof x.at === 'string' && !Number.isNaN(Date.parse(x.at))) out[id] = { sig: x.sig, at: x.at }
  }
  return out
}

/** Split a list into what shows and what's hidden. */
export function splitHidden<T extends { id: string }>(items: T[], hidden: HiddenMap, sig: (item: T) => string): { shown: T[]; hidden: T[] } {
  const shown: T[] = []
  const gone: T[] = []
  for (const item of items) (isHidden(hidden, item.id, sig(item)) ? gone : shown).push(item)
  return { shown, hidden: gone }
}
