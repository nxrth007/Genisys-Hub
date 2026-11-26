import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { requireStaff } from '@/lib/auth-helpers'
import { sendSiteUpdate, siteUpdateView } from '@/lib/hl/site-update'

/**
 * "Send Site Update" in a client's Sites folder (src/lib/hl/site-update.ts).
 *
 * GET — whether the button applies (the site is live on their own domain), who the text would go
 * to, and the last send. Nothing is sent.
 *
 * POST { to, email, includeLogin } — staff: text the owner now from Lead Genisys's GHL sub-account,
 * with a link to choose their Genisys OS password when includeLogin. Checked again first.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied
  const { id } = await params
  const view = await siteUpdateView(id)
  if (!view) return NextResponse.json({ error: 'Client not found' }, { status: 404 })
  return NextResponse.json(view)
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied
  const { id } = await params
  const body = (await req.json().catch(() => null)) as { to?: unknown; email?: unknown; includeLogin?: unknown } | null
  if (typeof body?.to !== 'string') return NextResponse.json({ error: 'send { "to": "(555) 123-4567", "email": "owner@example.com", "includeLogin": true }' }, { status: 400 })
  const session = await auth()
  try {
    const res = await sendSiteUpdate(id, {
      to: body.to,
      email: typeof body.email === 'string' ? body.email : null,
      includeLogin: body.includeLogin === true,
      by: session?.user?.name || session?.user?.email || 'staff',
    })
    return NextResponse.json(res, { status: res.ok ? 200 : 409 })
  } catch (err) {
    return NextResponse.json({ ok: false, reason: `The text didn’t go out: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 })
  }
}
