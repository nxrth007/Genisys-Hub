import { NextResponse, after } from 'next/server'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'
import { fireFormTriggers, publicForm, submitForm } from '@/lib/hl/forms'

type Ctx = { params: Promise<{ formId: string }> }

/**
 * The public side of a Hell-level form. Open to any website (CORS *) so a
 * client's Lovable site can post its own form here as well as embed ours.
 *   GET:  the form's fields and wording.
 *   POST: a submission (JSON or form-encoded). Rate-limited per IP.
 */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS })
}

export async function GET(_req: Request, { params }: Ctx) {
  const { formId } = await params
  const form = await publicForm(formId)
  if (!form) return NextResponse.json({ error: 'Form not found' }, { status: 404, headers: CORS })
  // Everything but the sub-account id.
  return NextResponse.json({ form: { id: form.id, kind: form.kind, name: form.name, business: form.business, fields: form.fields, settings: form.settings } }, { headers: CORS })
}

export async function POST(req: Request, { params }: Ctx) {
  const { formId } = await params
  const ip = clientIp(req)
  const limit = checkRateLimit(`hl-form:${ip ?? 'unknown'}`, 10, 10 * 60_000)
  if (!limit.ok) return NextResponse.json({ error: 'Too many submissions. Please try again in a few minutes.' }, { status: 429, headers: CORS })
  let raw: Record<string, unknown> = {}
  const type = req.headers.get('content-type') ?? ''
  try {
    if (type.includes('application/json')) raw = (await req.json()) as Record<string, unknown>
    else (await req.formData()).forEach((v, k) => (raw[k] = typeof v === 'string' ? v : ''))
  } catch {
    return NextResponse.json({ error: 'Couldn’t read the form.' }, { status: 400, headers: CORS })
  }
  // A filled honeypot means a bot.
  if (typeof raw._hp === 'string' && raw._hp) return NextResponse.json({ ok: true, thankYou: 'Thanks!' }, { headers: CORS })
  const pageUrl = typeof raw._page === 'string' ? raw._page.slice(0, 500) : req.headers.get('referer')
  try {
    const r = await submitForm(formId, raw, { ip: ip ?? null, pageUrl })
    if (!r.ok) return NextResponse.json({ error: r.error, field: r.field }, { status: 400, headers: CORS })
    after(() => fireFormTriggers(formId, r).catch((err) => console.error('[hell-level] form automations failed:', err)))
    return NextResponse.json({ ok: true, thankYou: r.thankYou }, { headers: CORS })
  } catch (err) {
    console.error('[hell-level] form submit failed:', err)
    return NextResponse.json({ error: 'Something went wrong. Please call us instead.' }, { status: 500, headers: CORS })
  }
}
