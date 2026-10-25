import { NextResponse } from 'next/server'
import { askResponse } from '@/lib/hl/ask'
import { accountAttention } from '@/lib/hl/ask-attention'
import { hlAccountOr404, hlError, hlGuard } from '@/lib/hl/http'

type Ctx = { params: Promise<{ id: string }> }

/** GET: Ask AI's "Needs attention" list for the sub-account. Genisys only (for now). */
export async function GET(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  try {
    return NextResponse.json(await accountAttention(id))
  } catch (err) {
    return hlError(err, 'load what needs attention')
  }
}

/** POST { messages: [{ role, text }] }: the answer to the last question, streamed as lines of JSON. */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  return askResponse(req, { kind: 'account', accountId: id }, guard.email)
}
