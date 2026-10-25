import { NextResponse } from 'next/server'
import { askResponse } from '@/lib/hl/ask'
import { agencyAttention } from '@/lib/hl/ask-attention'
import { hlError, hlGuard } from '@/lib/hl/http'

/** GET: Ask AI's "Needs attention" list across every sub-account. */
export async function GET() {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  try {
    return NextResponse.json(await agencyAttention())
  } catch (err) {
    return hlError(err, 'load what needs attention')
  }
}

/** POST { messages: [{ role, text }] }: the answer to the last question about all the clients, streamed. */
export async function POST(req: Request) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  return askResponse(req, { kind: 'agency' }, guard.email)
}
