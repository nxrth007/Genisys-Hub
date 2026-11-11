/**
 * Bodies the worker webhook accepts.
 *
 * The onboarding funnel already posts the intake envelope to
 * /api/webhooks/client-onboarding, and that path enqueues a job when
 * the worker is on. This parser is for a direct poke: an existing
 * client id, the same intake envelope (or a Supabase INSERT, if a
 * table is added later), or a GHL verification code.
 */
import { timingSafeEqual } from 'crypto'

export function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length === 0 || a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export type TriggerBody =
  | { kind: 'client'; clientId: string; force: boolean }
  | { kind: 'otp'; code: string; clientId: string | null }
  | { kind: 'intake'; body: Record<string, unknown> }
  | { kind: 'invalid'; error: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function parseTriggerBody(body: unknown): TriggerBody {
  if (!isRecord(body)) return { kind: 'invalid', error: 'Body was not a JSON object.' }

  if (typeof body.otp === 'string' && body.otp.trim()) {
    return {
      kind: 'otp',
      code: body.otp.trim(),
      clientId: typeof body.clientId === 'string' && body.clientId.trim() ? body.clientId.trim() : null,
    }
  }

  if (typeof body.clientId === 'string' && body.clientId.trim()) {
    return { kind: 'client', clientId: body.clientId.trim(), force: body.force === true }
  }

  // Supabase database webhook: { type: 'INSERT', record: { ...answers } }.
  if (body.type === 'INSERT' && isRecord(body.record)) {
    const record = body.record
    const submittedAt = typeof record.created_at === 'string' ? record.created_at : typeof record.submittedAt === 'string' ? record.submittedAt : undefined
    return {
      kind: 'intake',
      body: {
        event: 'intake.submitted',
        ...(submittedAt ? { submittedAt } : {}),
        source: 'supabase',
        answers: record,
      },
    }
  }

  if (isRecord(body.answers) || body.event === 'intake.submitted') {
    return { kind: 'intake', body }
  }

  return { kind: 'invalid', error: 'Expected clientId, otp, or an onboarding submission.' }
}
