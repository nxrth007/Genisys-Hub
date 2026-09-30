import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { getSecretByName } from '@/lib/vault-service'
import { ingestIntake, intakeDataFromBody, isRecord, looksLikeIntake, str } from '@/lib/client-intake-ingest'
import { hubAlertThrottled } from '@/lib/hub-alerts'

/**
 * POST /api/webhooks/client-onboarding
 *
 * Receives a submission from the client onboarding form at
 * clientonboarding.leadgenisys.com.
 *
 * Authenticated with a shared secret held in the Vault as "Client
 * Onboarding Webhook Secret". Accepts it three ways because the sender's
 * capabilities aren't known: an `x-webhook-secret` header, an
 * Authorization bearer, or `?secret=` for form tools that cannot set
 * headers at all.
 *
 * This route must stay listed in middleware's PUBLIC_PATHS. Without that
 * the global session check answers first and the sender sees a generic
 * 401 from a route it never reached.
 *
 * The verbatim body is stored alongside the parsed fields. The form will
 * gain questions faster than this schema does, and an answer that was
 * never written down is unrecoverable.
 *
 * This is the fast path, not the only one: the form forwards here only
 * when its INTAKE_WEBHOOK_URL setting points at this URL, and skips
 * silently when it doesn't. lib/onboarding-sheet.ts reads the form's
 * Google Sheet on a schedule and takes in anything this route never saw.
 */

export const dynamic = 'force-dynamic'

const SECRET_ENTRY = 'Client Onboarding Webhook Secret'

/** Constant-time compare that can't leak length via early return. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function POST(req: NextRequest) {
  let expected: string
  try {
    expected = (await getSecretByName(SECRET_ENTRY)).trim()
  } catch {
    return NextResponse.json(
      {
        error: 'not_configured',
        message: `Add the shared secret to the Hub vault as "${SECRET_ENTRY}".`,
      },
      { status: 503 },
    )
  }

  const provided =
    req.headers.get('x-webhook-secret') ??
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    req.nextUrl.searchParams.get('secret') ??
    ''

  // The body is read before the secret is checked so a rejected request
  // that clearly came from the form (it carries onboarding answers) can
  // be reported — a submission the Hub turns away is a client nobody
  // hears about. Random scanners send neither a secret nor answers and
  // are ignored quietly.
  const rawText = await req.text().catch(() => '')
  let body: Record<string, unknown> | null = null
  try {
    const v: unknown = JSON.parse(rawText)
    if (isRecord(v)) body = v
  } catch {
    body = null
  }
  const submission = looksLikeIntake(body)

  if (!provided || !secretMatches(provided, expected)) {
    if (submission || provided) {
      const answers = body && isRecord(body.answers) ? body.answers : body
      const who = str(answers?.businessName)
      await hubAlertThrottled(
        'onboarding:invalid_secret',
        30 * 60_000,
        `:rotating_light: *Onboarding webhook rejected a submission* — the secret it sent doesn't match the Vault entry "${SECRET_ENTRY}".${submission ? ` It looked like a real form entry${who ? ` for *${who}*` : ''}.` : ''} Check INTAKE_WEBHOOK_SECRET in the onboarding form's Lovable settings. The Hub will still pick the submission up from the onboarding sheet within a few minutes.`,
      )
    }
    // Deliberately distinct from middleware's generic "unauthorized", so
    // a wrong secret is distinguishable from never reaching the handler.
    return NextResponse.json(
      {
        error: 'invalid_secret',
        message: 'Missing or incorrect x-webhook-secret.',
      },
      { status: 401 },
    )
  }

  if (!body) {
    await hubAlertThrottled(
      'onboarding:invalid_json',
      30 * 60_000,
      ':rotating_light: *Onboarding webhook rejected a submission* — the body was not valid JSON. The form’s payload format may have changed.',
    )
    return NextResponse.json(
      { error: 'invalid_json', message: 'Body was not valid JSON.' },
      { status: 400 },
    )
  }

  // A body with none of the form's fields is a misconfigured sender or a
  // liveness probe, not a submission. Storing it would put a blank row
  // in front of whoever reads the intakes next.
  if (!submission) {
    await hubAlertThrottled(
      'onboarding:empty_payload',
      30 * 60_000,
      ':rotating_light: *Onboarding webhook received a submission with no answers in it* — the form’s field mapping may have changed. Nothing was stored.',
    )
    return NextResponse.json(
      { error: 'empty_payload', message: 'No onboarding fields were present.' },
      { status: 400 },
    )
  }

  // ?dryRun=1 parses and reports without storing, so a changed payload
  // shape can be checked against the running build before it goes live.
  if (req.nextUrl.searchParams.get('dryRun') === '1') {
    return NextResponse.json({ ok: true, dryRun: true, parsed: intakeDataFromBody(body) })
  }

  const result = await ingestIntake(body, 'webhook')
  return NextResponse.json({ ok: true, id: result.id, clientId: result.clientId, duplicate: result.duplicate })
}

/** A GET here is almost always someone checking the URL is live. */
export function GET() {
  return NextResponse.json({
    ok: true,
    message:
      'Client onboarding webhook is live. POST JSON with the x-webhook-secret header.',
    // Advertised so an importer can tell whether the running build will
    // honour an original submission time before it sends anything.
    acceptsSubmittedAt: true,
  })
}
