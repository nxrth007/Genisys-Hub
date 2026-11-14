/**
 * What Forge does when Lovable pauses a website build (pure; no imports). Alex,
 * 2026-11-14: Forge should "know what to click when Lovable asks questions so he
 * can get through a build properly", after Cnc transportation's build sat on
 * "Which should I tackle next?" in Lovable's editor.
 *
 * Lovable's API says a person decides its pauses: its answer call is "Use only
 * after a human has seen the pending action and decided". For a build, the
 * person's decision is the brief they approved with Build it (the one-shot).
 * So Forge answers a question only from that brief:
 *   - a line of the brief that settles it (quoted back in the log);
 *   - the brief's rule for anything it doesn't cover: keep what the template has;
 *   - "No, that's all" to extra work Lovable offers once the brief is done.
 * Everything else waits for a person, with Forge's suggestion beside it: a tool
 * Lovable wants approved, anything about money, credits, secrets, accounts,
 * publishing or deleting, a pause only Lovable's editor can answer, and any
 * question the brief can't settle.
 */

/** What Lovable paused on. */
export type PauseKind =
  /** It asks a person questions (Lovable's question card: options, or typed answers). */
  | 'questions'
  /** It wants a tool approved before running it. */
  | 'tool'
  /** A check-in, a secret or a credit check-in: only Lovable's editor can answer it. */
  | 'editor'

export type PauseQuestion = {
  /** The answer's key in Lovable's input schema. */
  key: string
  text: string
  options: { label: string; description: string | null }[]
  /** Several options may be picked. */
  multi: boolean
  /** No options: the answer is typed. (A person may also type their own answer to an options question, as Lovable's card allows; Forge never does.) */
  typed: boolean
  required: boolean
}

export type ForgeRead = {
  /** brief_settles: the brief answers it. brief_done: the brief is done and this offers extra work. person: anything else. */
  verdict: 'brief_settles' | 'brief_done' | 'person'
  /** The answer per question key (an option's label, or typed text); several labels for a multi question. */
  answers: Record<string, string | string[]>
  /** The brief's words that settle it (brief_settles). */
  briefLine: string
  why: string
}

export type SitePause = {
  kind: PauseKind
  /** The user message the pause was reported on (Forge's one-shot, or an earlier turn in the copy): Lovable's answer goes to it. */
  on?: string | null
  /** Lovable's event for the pause (respond_to_approval answers it); null for an editor-only check-in. */
  eventId: string | null
  toolId: string | null
  /** The tool's proposal, trimmed (shown to a person, never acted on as an instruction). */
  params: string | null
  questions: PauseQuestion[]
  /** What Lovable wrote before pausing. */
  reply: string | null
  /** Why only the editor can answer it, when kind is 'editor'. */
  editorWhy: string | null
  /** Forge's read of it, with its suggestion (null until read, or for editor-only pauses). */
  forge: ForgeRead | null
  at: string
}

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** An option as Lovable lists it: a plain value, or { label | value | const | title, description }. */
function optionOf(v: unknown): { label: string; description: string | null } | null {
  if (typeof v === 'string' || typeof v === 'number') return { label: String(v), description: null }
  const r = rec(v)
  if (!r) return null
  const label = str(r.label) ?? str(r.value) ?? (typeof r.const === 'string' ? r.const : null) ?? str(r.title) ?? str(r.name)
  return label ? { label, description: str(r.description) } : null
}

function optionsOf(schema: Record<string, unknown> | null): { options: { label: string; description: string | null }[]; multi: boolean } {
  if (!schema) return { options: [], multi: false }
  const items = rec(schema.items)
  const multi = schema.type === 'array'
  const source = multi ? items : schema
  const list = (source && (Array.isArray(source.enum) ? source.enum : Array.isArray(source.oneOf) ? source.oneOf : Array.isArray(source.anyOf) ? source.anyOf : null)) ?? (Array.isArray(schema.options) ? schema.options : null)
  const options = (list ?? []).map(optionOf).filter((o): o is { label: string; description: string | null } => !!o)
  return { options, multi }
}

/**
 * Lovable's questions from its input schema (a JSON schema object: one property
 * per question), falling back to a questions list in the tool's params.
 */
export function questionsOf(inputSchema: unknown, params: unknown): PauseQuestion[] {
  const schema = rec(inputSchema)
  const props = rec(schema?.properties)
  const required = new Set(Array.isArray(schema?.required) ? (schema!.required as unknown[]).filter((x): x is string => typeof x === 'string') : [])
  const out: PauseQuestion[] = []
  if (props) {
    for (const [key, raw] of Object.entries(props)) {
      const p = rec(raw)
      if (!p) continue
      const { options, multi } = optionsOf(p)
      const text = str(p.title) ?? str(p.description) ?? key
      out.push({ key, text: clip(text, 400), options, multi, typed: !options.length, required: required.has(key) })
    }
  }
  if (out.length) return out
  // Some tools list the questions in their params instead.
  const pr = rec(params)
  const list = Array.isArray(pr?.questions) ? (pr!.questions as unknown[]) : []
  list.forEach((q, i) => {
    const r = rec(q)
    const text = (r && (str(r.question) ?? str(r.text) ?? str(r.title) ?? str(r.header))) ?? (typeof q === 'string' ? q : null)
    if (!text) return
    const key = (r && (str(r.id) ?? str(r.key))) ?? `q${i + 1}`
    const options = (Array.isArray(r?.options) ? (r!.options as unknown[]) : []).map(optionOf).filter((o): o is { label: string; description: string | null } => !!o)
    out.push({ key, text: clip(text, 400), options, multi: r?.multiSelect === true || r?.multi === true, typed: !options.length, required: true })
  })
  return out
}

/** Tools only a person approves, whatever Forge reads: money, credits, secrets, accounts, going live, deleting, outside services. */
const PERSON_TOOLS = /secret|stripe|pay|billing|credit|key|token|password|auth|deploy|publish|domain|delete|remove|drop|supabase|database|cloud|github|connect|integration|email|sms|twilio|webhook/i

/** What Lovable paused on, from its awaiting_input object (null without one: a check-in for its editor). */
export function readPause(awaiting: Record<string, unknown> | null, reply: string | null, now: Date): SitePause {
  const base = { reply: reply ? clip(reply.trim(), 4000) : null, forge: null, at: now.toISOString() }
  if (!awaiting) return { kind: 'editor', eventId: null, toolId: null, params: null, questions: [], editorWhy: 'Lovable paused for a check-in that only its editor can answer.', ...base }
  const eventId = str(awaiting.event_id)
  const toolId = str(awaiting.tool_id) ?? str(awaiting.tool_name)
  const params = awaiting.params === undefined || awaiting.params === null ? null : clip(typeof awaiting.params === 'string' ? awaiting.params : JSON.stringify(awaiting.params), 3000)
  if (awaiting.requires_secure_form === true) {
    return { kind: 'editor', eventId, toolId, params, questions: [], editorWhy: 'Lovable wants a secret or key typed into its own form.', ...base }
  }
  if (/credit/i.test(`${toolId ?? ''} ${str(awaiting.reason) ?? ''}`)) {
    return { kind: 'editor', eventId, toolId, params, questions: [], editorWhy: 'Lovable wants a person to OK more credits.', ...base }
  }
  const questions = awaiting.input_schema ? questionsOf(awaiting.input_schema, awaiting.params) : []
  if (questions.length) return { kind: 'questions', eventId, toolId, params, questions, editorWhy: null, ...base }
  if (!eventId) return { kind: 'editor', eventId, toolId, params, questions: [], editorWhy: 'Lovable paused without saying what it needs.', ...base }
  return { kind: 'tool', eventId, toolId, params, questions: [], editorWhy: null, ...base }
}

/** Forge may answer this pause itself (from the brief); otherwise a person does. */
export function forgeMayAnswer(p: SitePause): boolean {
  if (p.kind !== 'questions' || !p.eventId) return false
  if (PERSON_TOOLS.test(p.toolId ?? '') && !/question|ask/i.test(p.toolId ?? '')) return false
  return true
}

/**
 * Forge's answer as Lovable takes it, after checking it against the questions:
 * an approval with the answers (each option one Lovable offered, every required
 * question answered), or a decline for extra work offered once the brief is
 * done. Null when it doesn't hold up: a person answers instead.
 */
export function forgeResponse(p: SitePause, read: ForgeRead): { decision: 'approved'; userInput: Record<string, string | string[]> } | { decision: 'rejected'; reason: string } | null {
  if (!forgeMayAnswer(p)) return null
  if (read.verdict === 'brief_done') return { decision: 'rejected', reason: 'No, that’s all for now: the brief is done. Please end here.' }
  if (read.verdict !== 'brief_settles' || !read.briefLine.trim()) return null
  const userInput: Record<string, string | string[]> = {}
  for (const q of p.questions) {
    const a = read.answers[q.key]
    const picked = Array.isArray(a) ? a.map((x) => String(x).trim()).filter(Boolean) : typeof a === 'string' && a.trim() ? [a.trim()] : []
    if (!picked.length) {
      if (q.required) return null
      continue
    }
    // Forge picks only what Lovable offered.
    if (q.options.length && picked.some((x) => !q.options.some((o) => o.label === x))) return null
    if (!q.multi && picked.length > 1) return null
    userInput[q.key] = q.multi ? picked : picked[0]
  }
  return Object.keys(userInput).length ? { decision: 'approved', userInput } : null
}

/** A person's answer from the folder, checked against the questions (null: not a valid answer). */
export function personResponse(p: SitePause, o: { decision: 'answer' | 'skip' | 'approve' | 'decline'; answers?: Record<string, unknown> }): { decision: 'approved'; userInput?: Record<string, string | string[]> } | { decision: 'rejected'; reason?: string } | null {
  if (p.kind === 'editor' || !p.eventId) return null
  if (o.decision === 'skip' || o.decision === 'decline') return { decision: 'rejected', reason: p.kind === 'questions' ? 'Skipped.' : 'Declined.' }
  if (o.decision === 'approve') return p.kind === 'tool' ? { decision: 'approved' } : null
  if (p.kind !== 'questions') return null
  const userInput: Record<string, string | string[]> = {}
  for (const q of p.questions) {
    const a = o.answers?.[q.key]
    const picked = Array.isArray(a) ? a.map((x) => String(x).trim()).filter(Boolean) : typeof a === 'string' && a.trim() ? [a.trim()] : []
    if (!picked.length) {
      if (q.required) return null
      continue
    }
    // A person may pick an option or write their own answer (Lovable's "Write your own…").
    if (!q.multi && picked.length > 1) return null
    userInput[q.key] = q.multi ? picked : picked[0]
  }
  return Object.keys(userInput).length ? { decision: 'approved', userInput } : null
}

/** A person can answer it from the Hub (the folder passes it on); otherwise only Lovable's editor can. */
export function pauseAnswerableInHub(p: SitePause | null): boolean {
  return !!p && p.kind !== 'editor' && !!p.eventId
}

/** One line for the log and texts: the questions, as asked. */
export function pauseSummary(p: SitePause): string {
  if (p.kind === 'questions') return clip(p.questions.map((q) => q.text).join(' / '), 300)
  if (p.kind === 'tool') return `Lovable wants to run “${p.toolId ?? 'a tool'}”.`
  return p.editorWhy ?? 'Lovable paused for a person.'
}

/** Forge's answer in words, for the log and the folder. */
export function answerWords(p: SitePause, userInput: Record<string, string | string[]>): string {
  return clip(
    p.questions
      .filter((q) => userInput[q.key] !== undefined)
      .map((q) => {
        const a = userInput[q.key]
        return `${Array.isArray(a) ? a.join(', ') : a}`
      })
      .join(' / '),
    300,
  )
}

/** How long before Forge's one-shot a turn in the copy counts as Lovable's own (the copy is seconds old then). */
export const COPY_CHAT_WINDOW_MS = 15 * 60_000

/**
 * A fresh copy gets a message from Lovable itself ("I've successfully remixed
 * this project. What would be a good next step?"), and its answer can stop on
 * a question ("Which should I tackle next?"). Forge's one-shot then sits queued
 * behind it (Cnc transportation, 2026-11-14). Such a turn isn't part of the
 * build: a user message in the copy that isn't Forge's, from shortly before the
 * one-shot. Forge declines its question so the brief runs. Anything else
 * holding the one-shot up waits for a person.
 */
export function isCopyChatTurn(m: { id: string; role: string | null; createdAt: string | null }, oneShot: { id: string; createdAt: string | null }): boolean {
  if (m.role !== 'user' || m.id === oneShot.id) return false
  const at = Date.parse(m.createdAt ?? '')
  const sent = Date.parse(oneShot.createdAt ?? '')
  if (Number.isNaN(at) || Number.isNaN(sent)) return false
  return at <= sent && sent - at <= COPY_CHAT_WINDOW_MS
}

/** At most this many answers from Forge per build: past it, a person answers (a build stuck in a loop of questions). */
export const MAX_FORGE_ANSWERS = 5

/** Read a saved pause back (JSON from the database); null when there's none or it's malformed. */
export function readSavedPause(v: unknown): SitePause | null {
  const r = rec(v)
  if (!r || typeof r.kind !== 'string' || typeof r.at !== 'string') return null
  return r as unknown as SitePause
}
