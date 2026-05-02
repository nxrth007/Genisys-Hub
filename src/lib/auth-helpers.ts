/**
 * Tiny route-level auth helpers. Middleware does role-based path
 * gating, but some endpoints accept multiple roles at the path level
 * and need finer-grained checks inside the handler — this is the
 * single place those checks live so the rules don't drift.
 */

import { NextResponse } from 'next/server'
import { auth } from '@/auth'

export type SessionUserShape = {
  id?: string
  role?: string
}

/**
 * Allow only staff (admin or member) to proceed. Returns null when
 * the user is staff; returns a NextResponse the route should return
 * directly otherwise.
 *
 * Used by endpoints that previously relied on middleware's
 * `/api/admin/*` blanket block, which we relaxed for specific paths
 * to give the agent role (Mary) access to a couple of admin
 * endpoints. Anything that should stay staff-only now calls this.
 */
export async function requireStaff(): Promise<NextResponse | null> {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as SessionUserShape).role
  if (role !== 'admin' && role !== 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  return null
}

/**
 * Stricter than requireStaff — admin role only. Used for genuinely
 * destructive operations where even Ethan (member) shouldn't be
 * able to act without explicitly elevating. Currently the only
 * gate point is master-tracker row delete + edit, where Alex's
 * intent was specifically "I (alex@) can do this, agents can't."
 */
export async function requireAdmin(): Promise<NextResponse | null> {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as SessionUserShape).role
  if (role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  return null
}
