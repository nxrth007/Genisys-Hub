import { NextResponse } from 'next/server'
import { recordEmailEvent } from '@/lib/hl/email'
import { verifyMailgunSignature } from '@/lib/hl/mailgun'

/**
 * POST: Mailgun's delivery news for every sub-account's email (one account
 * webhook): { signature: { timestamp, token, signature }, "event-data": {…} }.
 * Delivered, bounced, marked as spam and unsubscribed go onto the message and
 * the contact (src/lib/hl/email.ts).
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { signature?: Record<string, unknown>; 'event-data'?: Record<string, unknown> } | null
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Expected JSON' }, { status: 406 })
  if (!(await verifyMailgunSignature(body.signature ?? {}).catch(() => false))) return NextResponse.json({ error: 'Not signed by Mailgun' }, { status: 406 })
  await recordEmailEvent(body['event-data'] ?? {})
  return NextResponse.json({ ok: true })
}
