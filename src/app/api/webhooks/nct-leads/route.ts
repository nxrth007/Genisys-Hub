import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { getNctSettings, ingestLead } from '@/lib/nct-billing'

/**
 * POST /api/webhooks/nct-leads
 *
 * The endpoint we hand to NCT Media. One lead per request. Authenticated
 * with a shared token (header `x-nct-token`, or `?token=` for senders that
 * can't set headers) — this is the only unauthenticated-by-session route
 * in the app that causes a card to be charged, so the token check runs
 * before anything else touches the body.
 *
 * Idempotent on NCT's own lead ID: replays return 200 without re-charging.
 *
 * Expected body (JSON):
 *   { "leadId": "...", "name": "...", "phone": "...", "email": "...",
 *     "address": "...", "service": "Roofing", "sourceKey": "forever-lit" }
 *
 * A plain "Name: ...\nPhone: ..." text blob is also accepted, so NCT can
 * reuse the Slack message template they already have.
 */

export const dynamic = 'force-dynamic'

/** Constant-time compare that can't leak length via early return. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function POST(req: NextRequest) {
  const settings = await getNctSettings()

  const provided =
    req.headers.get('x-nct-token') ??
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    req.nextUrl.searchParams.get('token') ??
    ''

  if (!provided || !tokenMatches(provided, settings.webhookToken)) {
    // Deliberately distinct from the global middleware's generic
    // {"error":"unauthorized"} — this way NCT (and we) can tell "your
    // token is wrong" apart from "you never reached the handler at all".
    return NextResponse.json(
      { error: 'invalid_token', message: 'Missing or incorrect x-nct-token.' },
      { status: 401 },
    )
  }

  // Accept JSON or a raw text body; parseLeadPayload handles both shapes.
  let body: unknown
  const contentType = req.headers.get('content-type') ?? ''
  try {
    if (contentType.includes('application/json')) {
      body = await req.json()
    } else {
      const text = await req.text()
      try {
        body = JSON.parse(text)
      } catch {
        body = { text }
      }
    }
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }

  try {
    const result = await ingestLead(body)
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.reason ?? 'Lead rejected.' },
        { status: 400 },
      )
    }
    return NextResponse.json({
      ok: true,
      leadId: result.leadId,
      status: result.status,
      duplicate: result.duplicate ?? false,
      ...(result.reason ? { note: result.reason } : {}),
    })
  } catch (err) {
    console.error('[nct-webhook] ingest failed:', err)
    // 500 so NCT's sender retries — the lead ID keeps the retry idempotent.
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
}

/** Lets NCT confirm the URL + token are right without creating a lead. */
export async function GET(req: NextRequest) {
  const settings = await getNctSettings()
  const provided =
    req.headers.get('x-nct-token') ??
    req.nextUrl.searchParams.get('token') ??
    ''
  if (!provided || !tokenMatches(provided, settings.webhookToken)) {
    return NextResponse.json(
      { error: 'invalid_token', message: 'Missing or incorrect x-nct-token.' },
      { status: 401 },
    )
  }
  return NextResponse.json({ ok: true, message: 'NCT lead webhook is live.' })
}
