import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { externalWrite, WriteError } from '@/lib/external-write'
import { externalOptions } from '@/lib/external-api'

/**
 * PATCH /api/external/v1/agents/manage
 *
 * Approve, deny, revoke, restore, or change someone's role.
 *
 * Admin-only, and not just as a formality: `role` is a single column, so
 * writing it is how a person gains or loses everything — the Hub
 * included. Before this, any approved CRM user could revoke an agent,
 * which was too generous for an action with that blast radius.
 *
 * Three guards worth stating, because each prevents a mistake that
 * cannot be undone from inside the app:
 *   - you cannot change your own role (no locking yourself out)
 *   - the last remaining admin cannot be demoted (no locking everyone
 *     out; there would be no one left who could undo it)
 *   - client_* and team_* accounts are refused, because their access is
 *     driven by separate onboarding flows this screen knows nothing about
 */

const ASSIGNABLE_ROLES = [
  'admin',
  'member',
  'agent',
  'agent_pending',
  'agent_denied',
  'crm_user',
  'crm_pending',
  'crm_denied',
]

/** Roles that grant a person a Genisys sign-in of some kind. */
const ACTIVE_ROLES = ['admin', 'member', 'agent', 'crm_user']

export const PATCH = externalWrite(async ({ auth, body }) => {
  if (auth.user.role !== 'admin') {
    throw new WriteError(
      'Only an admin can change access. Ask an owner to make this change.',
      403,
    )
  }

  const id = String(body.id ?? '')
  const action = String(body.action ?? '')
  if (!id) throw new WriteError('id is required.')

  const target = await prisma.user.findUnique({ where: { id } })
  if (!target) throw new WriteError('Account not found.', 404)

  if (target.id === auth.user.id) {
    throw new WriteError(
      'You cannot change your own access from here — that is how people lock themselves out.',
    )
  }
  if (!ASSIGNABLE_ROLES.includes(target.role)) {
    throw new WriteError(
      `${target.email} is a ${target.role} account. Client and team access is managed by their own onboarding flow, not here.`,
    )
  }

  /** End every live CRM session for a user whose access just changed. */
  const endSessions = () =>
    prisma.apiToken.updateMany({
      where: { createdById: id, scope: 'session', revokedAt: null },
      data: { revokedAt: new Date() },
    })

  /** Refuse to remove the last admin — nobody would be left to undo it. */
  const guardLastAdmin = async (nextRole: string) => {
    if (target.role !== 'admin' || nextRole === 'admin') return
    const admins = await prisma.user.count({ where: { role: 'admin' } })
    if (admins <= 1) {
      throw new WriteError(
        'This is the only admin account. Promote someone else to admin first.',
      )
    }
  }

  if (action === 'setRole') {
    const role = String(body.role ?? '')
    if (!ASSIGNABLE_ROLES.includes(role)) {
      throw new WriteError(`"${role}" is not a role that can be set here.`)
    }
    await guardLastAdmin(role)

    await prisma.user.update({
      where: { id },
      data: {
        role,
        ...(ACTIVE_ROLES.includes(role) ? { approvedAt: new Date() } : {}),
      },
    })
    // Losing access should take effect now, not whenever the token expires.
    if (!ACTIVE_ROLES.includes(role)) await endSessions()
    return { id, role }
  }

  if (action === 'approve') {
    // Approving means "give them the live version of what they applied for".
    const next =
      target.role === 'crm_pending' || target.role === 'crm_denied'
        ? 'crm_user'
        : 'agent'
    await prisma.user.update({
      where: { id },
      data: { role: next, approvedAt: new Date(), approvedById: auth.user.id },
    })
    return { id, role: next }
  }

  if (action === 'deny' || action === 'revoke') {
    const next = target.role.startsWith('crm') ? 'crm_denied' : 'agent_denied'
    await guardLastAdmin(next)
    await prisma.user.update({ where: { id }, data: { role: next } })
    await endSessions()
    return { id, role: next }
  }

  if (action === 'signOut') {
    await endSessions()
    return { id, signedOut: true }
  }

  throw new WriteError(`Unknown action "${action}".`)
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
