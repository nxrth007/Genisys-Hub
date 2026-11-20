import { NextRequest } from 'next/server'
import { withOwnerApi, externalOptions } from '@/lib/external-api'
import { externalWrite, WriteError, requireOwner } from '@/lib/external-write'
import { prisma } from '@/lib/prisma'
import { MANUAL_STEPS, STEP_STATES, STEP_TITLE, TRACK_STEPS, isStepState, readStep } from '@/lib/tracker/derive'
import { listTracker, manualStepFor, setTrackerStep } from '@/lib/tracker/store'

/**
 * /api/external/v1/tracker — the derived client tracker for bots.
 *   GET   ?q=&show=&stage=&step=&state=&stripe=1&archived=1  → rows + summary (owner token;
 *                                                     stripe=1 keeps only clients Stripe knows)
 *   PATCH { clientId, step, status, note? }         → a hand mark on one of the five
 *                                                     hand-markable steps, audited (owner account)
 * Every other step is read from the Hub. Owner-gated: rows carry contact
 * emails. Status links are not exposed here.
 */
export const GET = withOwnerApi(async (req) => {
  const p = req.nextUrl.searchParams
  const show = p.get('show')
  const state = p.get('state')
  const list = await listTracker({
    q: p.get('q') ?? undefined,
    step: readStep(p.get('step')) ?? undefined,
    state: isStepState(state) ? state : undefined,
    stage: readStep(p.get('stage')) ?? undefined,
    show: show === 'stuck' || show === 'blocked' || show === 'complete' || show === 'working' ? show : 'all',
    stripe: p.get('stripe') === '1',
    includeArchived: p.get('archived') === '1',
  })
  return { ...list, steps: TRACK_STEPS, manualSteps: MANUAL_STEPS, states: STEP_STATES }
})

export const PATCH = externalWrite(async ({ auth, body }) => {
  requireOwner(auth)
  const clientId = String(body.clientId ?? '').trim()
  if (!clientId) throw new WriteError('clientId is required')
  const step = manualStepFor(body.step)
  if (!step) {
    const known = readStep(body.step)
    throw new WriteError(known ? `${STEP_TITLE[known]} is read from the Hub and can't be set by hand.` : `step must be one of: ${MANUAL_STEPS.join(', ')}`)
  }
  if (body.status !== 'done' && body.status !== 'pending') throw new WriteError('status must be done or pending')
  const exists = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true } })
  if (!exists) throw new WriteError('Client not found.', 404)
  const result = await setTrackerStep(clientId, step, body.status, {
    actor: `api:${auth.user.email}`,
    note: typeof body.note === 'string' ? body.note : null,
  })
  return { clientId, step, ...result }
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
