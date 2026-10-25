import { NextResponse } from 'next/server'
import { recordInboundEmail } from '@/lib/hl/email'
import { verifyMailgunSignature } from '@/lib/hl/mailgun'

/**
 * POST: an email to a sub-account's email subdomain (a reply, usually), as
 * Mailgun's route forwards it: form fields recipient, sender, from, subject,
 * body-plain, stripped-text, message-headers, attachment-count, and the
 * timestamp / token / signature it's signed with (src/lib/hl/email.ts).
 * A 406 tells Mailgun not to retry; anything else failing, it retries.
 */
export async function POST(req: Request) {
  let f: FormData
  try {
    f = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Expected a form' }, { status: 406 })
  }
  const get = (k: string) => {
    const v = f.get(k)
    return typeof v === 'string' ? v : ''
  }
  if (!(await verifyMailgunSignature({ timestamp: get('timestamp'), token: get('token'), signature: get('signature') }).catch(() => false))) {
    return NextResponse.json({ error: 'Not signed by Mailgun' }, { status: 406 })
  }
  let headers: [string, string][] = []
  try {
    const h: unknown = JSON.parse(get('message-headers') || '[]')
    if (Array.isArray(h)) headers = h.filter((x): x is unknown[] => Array.isArray(x) && x.length >= 2).map((x) => [String(x[0]), String(x[1])])
  } catch {
    // no headers: the Message-Id just isn't known
  }
  const r = await recordInboundEmail({
    recipient: get('recipient'),
    sender: get('sender'),
    from: get('from') || get('From'),
    subject: get('subject') || get('Subject'),
    bodyPlain: get('body-plain'),
    strippedText: get('stripped-text'),
    headers,
    attachments: Number(get('attachment-count')) || 0,
  })
  return NextResponse.json(r, { status: r.ok ? 200 : 406 })
}
