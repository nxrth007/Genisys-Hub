import { NextResponse, after } from 'next/server'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'
import { HOOK_ID_PATTERN } from '@/lib/hl/types'
import { readPayload, receiveWebhook } from '@/lib/hl/webhooks'

type Ctx = { params: Promise<{ hookId: string }> }

/**
 * An inbound webhook trigger's URL (src/lib/hl/webhooks.ts). POST or PUT
 * JSON, form data or text, up to 1 MB. Open to any website (CORS *), like
 * the form endpoint, so a site's own form can post straight here.
 */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, PUT, OPTIONS',
  'access-control-allow-headers': '*',
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS })
}

export function GET() {
  return NextResponse.json({ error: 'Send this URL a POST request with JSON or form data.' }, { status: 405, headers: { ...CORS, allow: 'POST, PUT, OPTIONS' } })
}

async function receive(req: Request, { params }: Ctx) {
  const { hookId } = await params
  if (!HOOK_ID_PATTERN.test(hookId)) return NextResponse.json({ error: 'This webhook URL isn’t in use.' }, { status: 404, headers: CORS })
  const ip = clientIp(req)
  if (!checkRateLimit(`hl-hook:${hookId}`, 120, 60_000).ok || !checkRateLimit(`hl-hook-ip:${ip ?? 'unknown'}`, 60, 60_000).ok) {
    return NextResponse.json({ error: 'Too many requests. Try again in a minute.' }, { status: 429, headers: CORS })
  }
  const read = await readPayload(req)
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: read.status, headers: CORS })
  try {
    const r = await receiveWebhook(hookId, read.payload, { ip: ip ?? null, contentType: read.contentType, bytes: read.bytes })
    if (r.later) {
      const work = r.later
      after(() => work().catch((err) => console.error(`[hell-level] webhook ${hookId.slice(0, 6)}… run failed:`, err)))
    }
    return NextResponse.json(r.body, { status: r.status, headers: CORS })
  } catch (err) {
    console.error('[hell-level] webhook failed:', err)
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500, headers: CORS })
  }
}

export const POST = receive
export const PUT = receive
