import { NextRequest, NextResponse } from 'next/server'
import { ingestIntake, isRecord, looksLikeIntake } from '@/lib/client-intake-ingest'
import { hubAlertThrottled } from '@/lib/hub-alerts'
import { enqueueClient, submitWorkerOtp, workerWebhookSecret } from '@/lib/ghl-subaccount-worker/queue'
import { parseTriggerBody, secretMatches } from '@/lib/ghl-subaccount-worker/trigger'

/**
 * POST /api/webhooks/ghl-subaccount-worker
 *
 * A direct trigger for the browser worker. The onboarding funnel does
 * not have to call this: its existing webhook (and the sheet reconcile)
 * already land in ingestIntake, which enqueues when the worker is on.
 *
 * Bodies:
 *   { clientId, force? }              queue that client
 *   { otp, clientId? }                a GHL verification code
 *   the intake envelope               same shape as /api/webhooks/client-onboarding
 *   { type: 'INSERT', record }        a Supabase database webhook, if one is added later
 *
 * Secret: GHL_SUBACCOUNT_WORKER_WEBHOOK_SECRET, else the Vault entry
 * "GHL Subaccount Worker Webhook Secret", else the onboarding webhook
 * secret. Header x-webhook-secret, Authorization bearer, or ?secret=.
 */

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const expected = await workerWebhookSecret()
  if (!expected) {
    return NextResponse.json(
      { error: 'not_configured', message: 'No webhook secret is set for the GHL sub-account worker.' },
      { status: 503 },
    )
  }

  const rawText = await req.text().catch(() => '')
  let body: unknown = null
  try {
    body = JSON.parse(rawText)
  } catch {
    body = null
  }
  const provided =
    req.headers.get('x-webhook-secret') ??
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    req.nextUrl.searchParams.get('secret') ??
    ''
  const looksReal = isRecord(body) && (looksLikeIntake(body) || typeof body.clientId === 'string' || typeof body.otp === 'string')
  if (!provided || !secretMatches(provided, expected)) {
    if (looksReal || provided) {
      await hubAlertThrottled(
        'ghl-subaccount-worker:secret',
        30 * 60_000,
        ':rotating_light: *GHL sub-account worker webhook rejected a call* — the secret did not match. Check GHL_SUBACCOUNT_WORKER_WEBHOOK_SECRET or the Vault entry.',
      )
    }
    return NextResponse.json({ error: 'invalid_secret', message: 'Missing or incorrect x-webhook-secret.' }, { status: 401 })
  }

  const parsed = parseTriggerBody(body)
  if (parsed.kind === 'invalid') {
    return NextResponse.json({ error: 'invalid_body', message: parsed.error }, { status: 400 })
  }
  if (parsed.kind === 'otp') {
    const result = await submitWorkerOtp(parsed.code, parsed.clientId)
    return NextResponse.json(result, { status: result.ok ? 200 : 400 })
  }
  if (parsed.kind === 'client') {
    const job = await enqueueClient(parsed.clientId, { trigger: 'webhook', force: parsed.force })
    return NextResponse.json({ ok: job.ok, job })
  }

  if (!looksLikeIntake(parsed.body)) {
    return NextResponse.json({ error: 'empty_payload', message: 'No onboarding fields were present.' }, { status: 400 })
  }
  const stored = await ingestIntake(parsed.body, 'webhook')
  // Don't pass createdNewClient: a duplicate delivery has created=false even
  // when this client was new. The queue derives that from the dates.
  const job = stored.clientId
    ? await enqueueClient(stored.clientId, { trigger: 'webhook', force: false, timeKnown: true })
    : null
  return NextResponse.json({ ok: true, id: stored.id, clientId: stored.clientId, duplicate: stored.duplicate, job })
}

export function GET() {
  return NextResponse.json({
    ok: true,
    message: 'GHL sub-account worker webhook. POST JSON with the x-webhook-secret header.',
  })
}
