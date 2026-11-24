import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { requireStaff } from '@/lib/auth-helpers'
import { gbpRows, queueSetupSends, skipSetupSends } from '@/lib/gbp-setup'

/**
 * The Google Profiles tab (staff).
 *   GET  → every active client's Google Business Profile standing, A–Z
 *   POST → { action: 'send', ids } queue those clients' setup pages (text + email, in daytime where they are)
 *          { action: 'skip', ids } Not now: leave them out of one-tap sends
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  const denied = await requireStaff()
  if (denied) return denied
  return NextResponse.json({ clients: await gbpRows() }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied
  const body = (await req.json().catch(() => ({}))) as { action?: unknown; ids?: unknown }
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 100) : []
  if (!ids.length || (body.action !== 'send' && body.action !== 'skip')) return NextResponse.json({ error: 'send { "action": "send" | "skip", "ids": ["..."] }' }, { status: 400 })
  const session = await auth()
  const by = (session?.user?.email as string | undefined) ?? null
  if (body.action === 'skip') return NextResponse.json({ skipped: await skipSetupSends(ids, by) })
  return NextResponse.json(await queueSetupSends(ids, by))
}
