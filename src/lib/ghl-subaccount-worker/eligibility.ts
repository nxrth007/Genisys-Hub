/**
 * Who gets a sub-account automatically. Same line the API path draws:
 * a brand-new client from a submission after the worker was switched
 * on, with a real business name and a readable submission time.
 * Forcing a job (the Retry button, a webhook with `force`) skips this.
 */

export type EligibilityInput = {
  receivedAt: Date
  since: Date
  timeKnown: boolean
  createdNewClient: boolean
  hasLocation: boolean
  phoneNamed: boolean
  /** The business name is a non-answer ("No", "N/A"), so the sub-account would be named "Robert: No". */
  nonAnswerNamed?: boolean
}

export const NON_ANSWER_REASON = 'business name looks like a non-answer'

const NON_ANSWERS = new Set([
  'no', 'none', 'n/a', 'na', 'n.a.', 'nope', 'nothing', 'null', 'nil', 'yes', 'idk',
  'unknown', 'tbd', 'test', 'asdf', 'business', 'company', 'llc', 'inc', 'my business',
])

/** A business name that is really an answer to some other question, or nothing at all. */
export function looksLikeNonAnswer(name: string | null | undefined): boolean {
  const text = (name ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  if (!text) return true
  if (NON_ANSWERS.has(text) || NON_ANSWERS.has(text.replace(/[.!?,]+$/g, ''))) return true
  return !/[a-z0-9]/.test(text)
}

export function autoEnqueueAllowed(input: EligibilityInput): { ok: true } | { ok: false; reason: string } {
  if (input.hasLocation) return { ok: false, reason: 'client already has a sub-account' }
  if (input.phoneNamed) return { ok: false, reason: 'business name looks like a phone number' }
  if (input.nonAnswerNamed) return { ok: false, reason: NON_ANSWER_REASON }
  if (!input.createdNewClient) return { ok: false, reason: 'submission was linked to a client already on file' }
  if (!input.timeKnown) return { ok: false, reason: 'submission time was not readable, so it may be an old row' }
  if (input.receivedAt.getTime() < input.since.getTime()) {
    return { ok: false, reason: 'submission is from before the browser worker was switched on' }
  }
  return { ok: true }
}

/** A sheet row with no timestamp is stored as "now"; the raw envelope says whether the time was real. */
export function intakeTimeKnown(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const body = raw as Record<string, unknown>
  if (typeof body.submittedAt === 'string' && !Number.isNaN(Date.parse(body.submittedAt))) return true
  if (body.event === 'intake.submitted') return true
  return false
}
