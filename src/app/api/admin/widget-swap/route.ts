import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { requireAdmin } from '@/lib/auth-helpers'
import { queueWidgetSwaps, readSwaps, resumeWidgetSwaps, unqueueWidgetSwaps } from '@/lib/hl/widget-swap'

/**
 * Client sites moving from GoHighLevel's quote form and chat bubble to Hell-level's
 * (src/lib/hl/widget-swap.ts). Admin only.
 * GET: every swap, with where it is and its log.
 * POST { clientIds, again? }: queue them (the scheduler runs two at a time). The 13 clients verified
 *   on GoHighLevel are refused; `again` redoes one that's done.
 * POST { action: 'unqueue', clientIds }: take queued ones off the queue.
 * POST { action: 'resume', clientIds }: pick failed ones up again at the step they stopped at (only
 *   after Lovable was sent the swap; nothing is sent twice).
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  const denied = await requireAdmin()
  if (denied) return denied
  return NextResponse.json({ swaps: await readSwaps() })
}

export async function POST(req: Request) {
  const denied = await requireAdmin()
  if (denied) return denied
  const session = await auth()
  const by = session?.user?.email || session?.user?.id || 'an admin'
  const body = (await req.json().catch(() => null)) as { action?: unknown; clientIds?: unknown; again?: unknown } | null
  const clientIds = Array.isArray(body?.clientIds) ? body.clientIds.filter((x): x is string => typeof x === 'string' && /^[a-z0-9]{10,40}$/i.test(x)) : []
  if (!clientIds.length || clientIds.length > 50) {
    return NextResponse.json({ error: 'Send { "clientIds": ["..."] } (1 to 50), with "again": true to redo a done one, or "action": "unqueue".' }, { status: 400 })
  }
  if (body?.action === 'unqueue') return NextResponse.json({ results: await unqueueWidgetSwaps(clientIds, by) })
  if (body?.action === 'resume') return NextResponse.json({ results: await resumeWidgetSwaps(clientIds, by) })
  if (body?.action !== undefined && body.action !== 'queue') return NextResponse.json({ error: 'action is "queue" (the default), "unqueue" or "resume".' }, { status: 400 })
  return NextResponse.json({ results: await queueWidgetSwaps(clientIds, by, { again: body?.again === true }) })
}
