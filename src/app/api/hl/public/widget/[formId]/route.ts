import { NextResponse } from 'next/server'
import { greetingOf, publicForm } from '@/lib/hl/forms'

type Ctx = { params: Promise<{ formId: string }> }

const HEADERS = { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' }

/** GET: what the chat bubble (/hl/widget.js) shows before it's opened: its colour, the pop-up greeting, the business logo. */
export async function GET(_req: Request, { params }: Ctx) {
  const { formId } = await params
  const form = await publicForm(formId)
  if (!form || form.kind !== 'chat') return NextResponse.json({ error: 'No such chat widget.' }, { status: 404, headers: HEADERS })
  return NextResponse.json({ color: form.settings.color ?? '#155EEF', greeting: greetingOf(form.settings), logo: form.logo, business: form.business }, { headers: HEADERS })
}
