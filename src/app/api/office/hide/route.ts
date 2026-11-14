import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { requireStaff } from '@/lib/auth-helpers'
import { setHidden } from '@/lib/office/hidden'

/**
 * POST /api/office/hide { id, sig, hidden } — hide an Office question from the Office floor, your
 * own main view (or show it there again); the Requests tab still lists it. It answers nothing: the bot keeps waiting and the question stays
 * answerable. `sig` is what the item said (src/lib/office/hide-plan.ts): when it says something
 * new, it shows again. Staff; each person hides for themselves.
 */
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied
  const session = await auth()
  const who = session?.user?.email || session?.user?.id || null
  if (!who) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 })
  const body = (await req.json().catch(() => null)) as { id?: unknown; sig?: unknown; hidden?: unknown } | null
  const id = typeof body?.id === 'string' ? body.id.trim() : ''
  const sig = typeof body?.sig === 'string' ? body.sig : ''
  if (!id || id.length > 300 || !sig || sig.length > 2000 || typeof body?.hidden !== 'boolean') {
    return NextResponse.json({ error: 'send { "id": "...", "sig": "...", "hidden": true | false }' }, { status: 400 })
  }
  const hidden = await setHidden(who, { id, sig, hidden: body.hidden })
  return NextResponse.json({ ok: true, hidden })
}
