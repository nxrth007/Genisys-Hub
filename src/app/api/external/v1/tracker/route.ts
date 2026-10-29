import { NextRequest } from 'next/server'
import { withOwnerApi, externalOptions } from '@/lib/external-api'
import { externalWrite, WriteError, requireOwner } from '@/lib/external-write'
import { prisma } from '@/lib/prisma'
import { isTrackerStatus, isTrackerStep, TRACKER_STEPS, TRACKER_STATUSES } from '@/lib/tracker/columns'
import { listTracker, setTrackerStep } from '@/lib/tracker/store'

/**
 * /api/external/v1/tracker — the DB client tracker for bots.
 *   GET   ?q=&step=&status=&archived=1      → rows (owner token)
 *   PATCH { clientId, step, status, note? }  → set one step, audited (owner account)
 * Owner-gated: rows carry contact emails. Status links are not exposed here.
 */
export const GET = withOwnerApi(async (req) => {
  const p = req.nextUrl.searchParams
  const step = p.get('step')
  const status = p.get('status')
  const rows = await listTracker({
    q: p.get('q') ?? undefined,
    step: isTrackerStep(step) ? step : undefined,
    status: isTrackerStatus(status) ? status : undefined,
    includeArchived: p.get('archived') === '1',
  })
  return { rows, steps: TRACKER_STEPS, statuses: TRACKER_STATUSES }
})

export const PATCH = externalWrite(async ({ auth, body }) => {
  requireOwner(auth)
  const clientId = String(body.clientId ?? '').trim()
  if (!clientId) throw new WriteError('clientId is required')
  if (!isTrackerStep(body.step)) throw new WriteError(`step must be one of: ${TRACKER_STEPS.join(', ')}`)
  if (!isTrackerStatus(body.status)) throw new WriteError(`status must be one of: ${TRACKER_STATUSES.join(', ')}`)
  const exists = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true } })
  if (!exists) throw new WriteError('Client not found.', 404)
  const result = await setTrackerStep(clientId, body.step, body.status, {
    actor: `api:${auth.user.email}`,
    note: typeof body.note === 'string' ? body.note : null,
  })
  return { clientId, step: body.step, ...result }
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
