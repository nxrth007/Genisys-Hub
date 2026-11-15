import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { requireAdmin, requireStaff } from '@/lib/auth-helpers'
import { clientReportView, sendClientReport } from '@/lib/hl/client-report'

/**
 * The client report in their Sites folder (src/lib/hl/client-report.ts).
 *
 * GET — whether they're fully set up (each item), and when they are, what the email would say:
 * their last 30 days, their setup, who it goes to. Nothing is sent.
 *
 * POST { to, includeLogin } — admin only: email it to the client now, with the link to choose their
 * dashboard password when includeLogin. Checked again first.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied
  const { id } = await params
  const view = await clientReportView(id)
  if (!view) return NextResponse.json({ error: 'Client not found or archived' }, { status: 404 })
  return NextResponse.json(view)
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin()
  if (denied) return denied
  const { id } = await params
  const body = (await req.json().catch(() => null)) as { to?: unknown; includeLogin?: unknown } | null
  if (typeof body?.to !== 'string') return NextResponse.json({ error: 'send { "to": "owner@example.com", "includeLogin": true }' }, { status: 400 })
  const session = await auth()
  try {
    const res = await sendClientReport(id, { to: body.to, includeLogin: body.includeLogin === true, by: session?.user?.name || session?.user?.email || 'an admin' })
    return NextResponse.json(res, { status: res.ok ? 200 : 409 })
  } catch (err) {
    return NextResponse.json({ ok: false, reason: `The email didn’t go out: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 })
  }
}
