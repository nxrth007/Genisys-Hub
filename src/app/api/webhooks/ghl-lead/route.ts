import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { getSecretByName } from '@/lib/vault-service'
import { hubAlertThrottled } from '@/lib/hub-alerts'
import { LEAD_WEBHOOK_SECRET_ENTRY, handleGhlLead, parseGhlLead } from '@/lib/lead-alert'

/**
 * POST /api/webhooks/ghl-lead?secret=…
 *
 * The Webhook action of the "Lead alert → Hub" workflow that every client
 * sub-account carries posts each form / chat-widget lead here. See
 * lib/lead-alert.ts for what happens next.
 *
 * GHL's Webhook action can't sign requests, so the secret rides in the
 * URL (`x-webhook-secret` and a Bearer token also work). The value lives
 * in the Vault as "GHL Lead Webhook Secret"; Settings → Lead texts creates
 * it and shows the full URL.
 *
 * Must stay in middleware's PUBLIC_PATHS. Answers 200 for every lead it
 * accepted, sent or not, so GHL doesn't retry a deliberate skip; a 5xx
 * (database down) does get retried, and the ledger dedupes the retry.
 */

export const dynamic = 'force-dynamic'

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function POST(req: NextRequest) {
  let expected: string
  try {
    expected = (await getSecretByName(LEAD_WEBHOOK_SECRET_ENTRY)).trim()
  } catch {
    return NextResponse.json(
      { error: 'not_configured', message: `Add "${LEAD_WEBHOOK_SECRET_ENTRY}" from Settings → Lead texts.` },
      { status: 503 },
    )
  }

  const provided =
    req.headers.get('x-webhook-secret') ??
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    req.nextUrl.searchParams.get('secret') ??
    ''
  if (!provided || !secretMatches(provided, expected)) {
    if (provided) {
      await hubAlertThrottled(
        'lead-alert:invalid_secret',
        30 * 60_000,
        `:rotating_light: *Lead webhook rejected a post* — the secret in the URL doesn't match the Vault entry "${LEAD_WEBHOOK_SECRET_ENTRY}". A sub-account's workflow has an old URL; copy the current one from Settings → Lead texts.`,
      )
    }
    return NextResponse.json({ error: 'invalid_secret' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    const v: unknown = await req.json()
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object')
    body = v as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  // ?dryRun=1 shows how a payload would be read without logging or texting.
  if (req.nextUrl.searchParams.get('dryRun') === '1') {
    return NextResponse.json({ ok: true, dryRun: true, parsed: parseGhlLead(body) })
  }

  const result = await handleGhlLead(body)
  if (result.status === 'invalid') {
    return NextResponse.json({ error: 'invalid_payload', message: result.reason }, { status: 400 })
  }
  return NextResponse.json({ ok: true, ...result })
}

export function GET() {
  return NextResponse.json({ ok: true, message: 'GHL lead webhook is live. POST the workflow payload with ?secret=.' })
}
