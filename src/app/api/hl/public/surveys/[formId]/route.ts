import { NextResponse, after } from 'next/server'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'
import { fireTrigger } from '@/lib/hl/automation'
import { submitSurvey } from '@/lib/hl/review-survey'

type Ctx = { params: Promise<{ formId: string }> }

/**
 * The review survey's answers (src/lib/hl/review-survey.ts). A high rating
 * comes back with where to go to leave a Google review; a low one with its
 * feedback starts the survey's "form submitted" automations.
 */
export async function POST(req: Request, { params }: Ctx) {
  const { formId } = await params
  const ip = clientIp(req)
  const limit = checkRateLimit(`hl-survey:${ip ?? 'unknown'}`, 20, 10 * 60_000)
  if (!limit.ok) return NextResponse.json({ error: 'Too many tries. Please try again in a few minutes.' }, { status: 429 })
  let body: Record<string, unknown> = {}
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Couldn’t read that.' }, { status: 400 })
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  try {
    const r = await submitSurvey(
      formId,
      { rating: Number(body.rating), name: str(body.full_name), email: str(body.email), feedback: str(body.your_feedback), token: str(body.c) },
      { ip: ip ?? null, pageUrl: req.headers.get('referer') },
    )
    if (!r.ok) return NextResponse.json({ error: r.error, field: r.field }, { status: 400 })
    if ('redirect' in r) return NextResponse.json({ ok: true, redirect: r.redirect })
    after(() =>
      fireTrigger(r.accountId, r.contactId, { type: 'form_submitted', formId, context: { form: r.answers, formId } }).catch((err) => console.error('[hell-level] survey automations failed:', err)),
    )
    return NextResponse.json({ ok: true, thankYou: r.thankYou })
  } catch (err) {
    console.error('[hell-level] survey submit failed:', err)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
