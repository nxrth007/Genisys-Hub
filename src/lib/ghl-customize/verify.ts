/**
 * The check that decides whether a Workflow AI edit may be saved.
 *
 * GHL's workflow builder sends the whole workflow as JSON when it loads and
 * when Save is pressed. The format is GHL's own and undocumented, so this
 * reads it loosely: a step is any object whose name/title/label is the
 * step's name, and its message is any text inside that object. A step
 * passes only if one of its texts is the Hub's copy (spacing and HTML
 * aside) and, for owner notifications, the recipient is the client's
 * email or number. Pure, so it is unit-tested with sample payloads.
 */
import type { ExpectedAction } from './copy'

type Obj = Record<string, unknown>

const NAME_KEYS = ['name', 'title', 'label', 'actionName', 'displayName']
const HTML_TAG = /<\/?(p|br|div|span|strong|em|b|i|u|a|ul|ol|li|h[1-6]|font|section|table|tr|td)\b[^>]*>/i

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export function normName(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'", '#160': ' ' }

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
    const known = ENTITIES[code.toLowerCase()]
    if (known !== undefined) return known
    if (code.startsWith('#x') || code.startsWith('#X')) return String.fromCodePoint(parseInt(code.slice(2), 16))
    if (code.startsWith('#')) return String.fromCodePoint(parseInt(code.slice(1), 10))
    return m
  })
}

/** Rich-text email bodies: paragraphs and line breaks become new lines, tags go. */
export function htmlToText(s: string): string {
  return decodeEntities(
    s
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
}

/**
 * The text as a reader sees it: spacing, line breaks, curly quotes and the
 * spacing inside {{merge fields}} don't count. Words, punctuation, links and
 * merge fields do.
 */
export function normalizeText(s: string): string {
  const plain = HTML_TAG.test(s) ? htmlToText(s) : decodeEntities(s)
  return plain
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/ /g, ' ')
    .replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, inner: string) => `{{${inner.replace(/\s+/g, ' ').trim()}}}`)
    .replace(/\s+/g, ' ')
    .trim()
}

function digits(s: string): string {
  return s.replace(/\D/g, '')
}

/** Every string inside a value, depth-first, with limits so a huge payload can't stall the job. */
export function collectStrings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (out.length > 2000 || depth > 12) return out
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const item of v) collectStrings(item, out, depth + 1)
  else if (isObj(v)) for (const item of Object.values(v)) collectStrings(item, out, depth + 1)
  return out
}

function nameOf(o: Obj): string | null {
  for (const key of NAME_KEYS) {
    const value = o[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

/** Objects anywhere in the payload whose name is one of `names`, keyed by the normalized name. */
export function findNamedNodes(json: unknown, names: string[]): Map<string, Obj[]> {
  const wanted = new Set(names.map(normName))
  const found = new Map<string, Obj[]>()
  let visited = 0
  const walk = (v: unknown, depth: number) => {
    if (visited > 50_000 || depth > 14) return
    visited += 1
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1)
      return
    }
    if (!isObj(v)) return
    const name = nameOf(v)
    if (name && wanted.has(normName(name))) {
      const key = normName(name)
      found.set(key, [...(found.get(key) ?? []), v])
    }
    for (const item of Object.values(v)) walk(item, depth + 1)
  }
  walk(json, 0)
  return found
}

/** A node carries a message when it has a longer text or a merge field (a canvas tile with only a name doesn't). */
function hasMessage(node: Obj, name: string): boolean {
  return collectStrings(node).some((s) => normName(s) !== normName(name) && (s.trim().length >= 20 || s.includes('{{')))
}

function nodeKey(node: Obj): string {
  const id = node.id ?? node._id ?? node.key
  return typeof id === 'string' && id ? `id:${id}` : `json:${JSON.stringify(node).slice(0, 4000)}`
}

export type ActionCheck = { name: string; ok: boolean; problem?: string }

/** Where the closest text first differs from the copy, for the job log. */
function firstDifference(want: string, texts: string[]): string {
  let best = ''
  let bestPrefix = -1
  for (const t of texts) {
    let i = 0
    while (i < t.length && i < want.length && t[i] === want[i]) i++
    if (i > bestPrefix) {
      bestPrefix = i
      best = t
    }
  }
  if (!best) return 'no text in the step'
  const at = Math.max(0, bestPrefix - 20)
  return `GHL has "…${best.slice(at, bestPrefix + 60)}…", the copy has "…${want.slice(at, bestPrefix + 60)}…"`
}

export function checkAction(node: Obj, expected: ExpectedAction): ActionCheck {
  const strings = collectStrings(node)
  const want = normalizeText(expected.text)
  const texts = strings.map(normalizeText)
  if (!texts.includes(want)) {
    return { name: expected.name, ok: false, problem: `the message isn't the Hub's copy: ${firstDifference(want, texts.filter((t) => t.length >= 20))}` }
  }
  if (expected.email) {
    const email = expected.email.trim().toLowerCase()
    if (!strings.some((s) => s.toLowerCase().includes(email))) {
      return { name: expected.name, ok: false, problem: `it doesn't send to ${expected.email}` }
    }
  }
  if (expected.phone) {
    const want10 = digits(expected.phone).slice(-10)
    const sendsThere = want10.length === 10 && strings.some((s) => s.length <= 40 && digits(s).length >= 10 && digits(s).slice(-10) === want10)
    if (!sendsThere) return { name: expected.name, ok: false, problem: `it doesn't send to ${expected.phone}` }
  }
  return { name: expected.name, ok: true }
}

export type WorkflowCheck = {
  /** The payload names at least one of the workflow's steps (it is this workflow's data). */
  found: boolean
  ok: boolean
  checks: ActionCheck[]
  summary: string
}

/**
 * Check one workflow payload against the copy for its steps. Every step must
 * appear, carry its message, and (if it's an owner notification) go to the
 * right place. A step that shows up more than once must match every time.
 */
export function verifyWorkflowJson(json: unknown, actions: ExpectedAction[]): WorkflowCheck {
  const nodes = findNamedNodes(json, actions.map((a) => a.name))
  const found = nodes.size > 0
  const checks: ActionCheck[] = actions.map((a) => {
    const all = nodes.get(normName(a.name)) ?? []
    const withMessage = [...new Map(all.filter((n) => hasMessage(n, a.name)).map((n) => [nodeKey(n), n])).values()]
    if (!all.length) return { name: a.name, ok: false, problem: 'the step is not in the workflow' }
    if (!withMessage.length) return { name: a.name, ok: false, problem: 'the step has no message' }
    for (const n of withMessage) {
      const c = checkAction(n, a)
      if (!c.ok) return c
    }
    return { name: a.name, ok: true }
  })
  const ok = found && checks.every((c) => c.ok)
  const bad = checks.filter((c) => !c.ok)
  const summary = !found
    ? 'none of the steps are in this data'
    : ok
      ? `all ${checks.length} steps match the Hub's copy`
      : bad.map((c) => `"${c.name}": ${c.problem}`).join('; ')
  return { found, ok, checks, summary }
}

/**
 * A short JSON sample of how a payload stores one step, for the job log when
 * a check fails (the format is GHL's own; this is how it gets learned).
 */
export function stepSample(json: unknown, name: string, max = 1200): string {
  const nodes = findNamedNodes(json, [name]).get(normName(name)) ?? []
  const node = nodes.find((n) => hasMessage(n, name)) ?? nodes[0]
  if (!node) return `no object named "${name}"`
  const text = JSON.stringify(node)
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** The steps a check found wrong, each with a sample of how the payload stores it. */
export function failureSamples(json: unknown, check: WorkflowCheck, max = 900): string {
  return check.checks
    .filter((c) => !c.ok)
    .slice(0, 2)
    .map((c) => `"${c.name}" in GHL's data: ${stepSample(json, c.name, max)}`)
    .join(' | ')
}

/** Names of every named object in a payload, counted, so a save can be compared with the workflow as it loaded. */
export function namedNodeCounts(json: unknown): Map<string, number> {
  const counts = new Map<string, number>()
  const seen = new Set<string>()
  let visited = 0
  const walk = (v: unknown, depth: number) => {
    if (visited > 50_000 || depth > 14) return
    visited += 1
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1)
      return
    }
    if (!isObj(v)) return
    const name = nameOf(v)
    if (name) {
      const key = `${normName(name)}|${nodeKey(v)}`
      if (!seen.has(key)) {
        seen.add(key)
        counts.set(normName(name), (counts.get(normName(name)) ?? 0) + 1)
      }
    }
    for (const item of Object.values(v)) walk(item, depth + 1)
  }
  walk(json, 0)
  return counts
}

/**
 * Steps that appear or disappear between two loads of the same workflow
 * (the workflow as it opened, and as it reloads after the save). Workflow AI
 * is told not to add or remove steps; this is how the job notices if it did.
 */
export function stepNameChanges(before: unknown, after: unknown): { added: string[]; removed: string[] } {
  const a = namedNodeCounts(before)
  const b = namedNodeCounts(after)
  const added: string[] = []
  const removed: string[] = []
  for (const [name, n] of b) if (n > (a.get(name) ?? 0)) added.push(name)
  for (const [name, n] of a) if (n > (b.get(name) ?? 0)) removed.push(name)
  return { added, removed }
}
