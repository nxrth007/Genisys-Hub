import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { externalWrite, WriteError } from '@/lib/external-write'
import { externalOptions } from '@/lib/external-api'

/**
 * PATCH /api/external/v1/agents/manage — revoke or restore an agent.
 *
 * Deliberately narrow. `role` is a single column, so writing to it is
 * how someone loses access — and only agent accounts are eligible here.
 * Admin and member accounts are refused outright: demoting an owner from
 * a phone-sized UI is a mistake nobody should be one tap away from, and
 * it would lock them out of the Hub itself.
 */

const AGENT_ROLES = ['agent', 'agent_pending', 'agent_denied']

export const PATCH = externalWrite(async ({ auth, body }) => {
  const id = String(body.id ?? '')
  const action = String(body.action ?? '')
  if (!id) throw new WriteError('id is required.')

  const target = await prisma.user.findUnique({ where: { id } })
  if (!target) throw new WriteError('Agent not found.', 404)

  if (!AGENT_ROLES.includes(target.role)) {
    throw new WriteError(
      `${target.email} is a ${target.role} account, not an agent. Staff and owner roles can only be changed in the Hub.`,
    )
  }
  if (target.id === auth.user.id) {
    throw new WriteError('You cannot change your own access.')
  }

  if (action === 'revoke') {
    await prisma.user.update({
      where: { id },
      data: { role: 'agent_denied' },
    })
    // Kill any CRM sessions they hold, rather than waiting for expiry.
    await prisma.apiToken.updateMany({
      where: { createdById: id, scope: 'session', revokedAt: null },
      data: { revokedAt: new Date() },
    })
    return { id, role: 'agent_denied' }
  }

  if (action === 'restore') {
    await prisma.user.update({
      where: { id },
      data: { role: 'agent', approvedAt: new Date() },
    })
    return { id, role: 'agent' }
  }

  throw new WriteError(`Unknown action "${action}".`)
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
