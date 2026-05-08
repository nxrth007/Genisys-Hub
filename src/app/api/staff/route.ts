import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/staff
 *
 * List of internal team members for the Assignee dropdown on
 * /today. Sorted by name.
 *
 * Returns:
 *   - users: id + name + email + role. Includes admin + member
 *     + agent rows from the User table, PLUS any synthetic team
 *     members from EXTRA_TEAM_MEMBERS (people on the team who
 *     don't have a Hub login but whose tasks still show up in
 *     Notion — e.g. Garrett today).
 *   - me: caller's row when present, null otherwise. Lets the
 *     client default the dropdown to "Me" without a separate
 *     session fetch.
 *
 * Staff-only because the list reveals workspace membership which
 * isn't appropriate for client / agent roles to see.
 */

/**
 * Hardcoded team members who don't have a Hub User row but
 * whose tasks still appear in Notion (so the Assignee dropdown
 * needs to surface them as filter options). Synthetic ids use
 * an "extra:" prefix so a future migration creating real Hub
 * accounts doesn't collide. Add new entries here as the team
 * grows; remove an entry once the person gets a real Hub login.
 */
const EXTRA_TEAM_MEMBERS = [
  {
    id: 'extra:garrett',
    name: 'Garrett',
    email: 'garrett@external',
    role: 'member' as const,
  },
]

export async function GET() {
  const denial = await requireStaff()
  if (denial) return denial
  const session = await auth()
  const meId = session?.user?.id

  // admin + member + agent — Mary (agent) is a Notion assignee
  // that Ethan asked to be able to filter to.
  const dbUsers = await prisma.user.findMany({
    where: { role: { in: ['admin', 'member', 'agent'] } },
    select: { id: true, name: true, email: true, role: true },
    orderBy: [{ name: 'asc' }, { email: 'asc' }],
  })

  // Merge synthetic team members. De-dupe by lowercased email so
  // adding a Hub account for Garrett later doesn't double him up
  // in the list.
  const seenEmails = new Set(dbUsers.map((u) => u.email.toLowerCase()))
  const extras = EXTRA_TEAM_MEMBERS.filter(
    (u) => !seenEmails.has(u.email.toLowerCase()),
  )
  const users = [...dbUsers, ...extras].sort((a, b) =>
    (a.name || a.email).localeCompare(b.name || b.email),
  )

  const me = meId ? dbUsers.find((u) => u.id === meId) ?? null : null

  return NextResponse.json({ users, me })
}
