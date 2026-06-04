/**
 * Helpers for the team-manager delegation (Mary approving Team #1
 * registrations + assigning initial call-center numbers).
 *
 * Shared between the manager API endpoints + Mary's /team/manage
 * page so the "what does manager permission mean" logic doesn't
 * fork.
 */

import { prisma } from './prisma'

/** Resolve the team number this user can manage, if any. Returns
 *  the team number for direct managers (User.managesTeamNumber)
 *  AND for admin/member roles (they can manage every team). null
 *  when the caller is neither.
 *
 *  Implementation note: admin/member bypass the User column check
 *  entirely so this helper works as the single source of truth for
 *  every "who can act on Team #N" decision, including the admin
 *  surface that still uses it as a sanity guard. */
export async function getManageableTeamNumber(opts: {
  userId: string
  role: string | null | undefined
  /** When set, the caller is only authorized if the resolved team
   *  matches. Useful for endpoints that take a team number in the
   *  URL — pass it in to short-circuit the "wrong team" case. */
  requireTeam?: number
}): Promise<number | null> {
  const { userId, role, requireTeam } = opts
  // Admin + member can manage any team. We still return the
  // requested team (or 1 as the default Team #N today) so the
  // caller has a consistent value to query against.
  if (role === 'admin' || role === 'member') {
    return requireTeam ?? 1
  }
  // Agents need an explicit managesTeamNumber flag.
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { managesTeamNumber: true },
  })
  if (!row?.managesTeamNumber) return null
  if (requireTeam !== undefined && row.managesTeamNumber !== requireTeam) {
    return null
  }
  return row.managesTeamNumber
}
