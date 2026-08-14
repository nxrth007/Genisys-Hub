import { NextRequest } from 'next/server'
import { listSubAccounts, updateOpportunityStage } from '@/lib/ghl'
import { externalWrite, WriteError } from '@/lib/external-write'
import { externalOptions } from '@/lib/external-api'

/**
 * PATCH /api/external/v1/opportunities/move
 * body: { subAccount, opportunityId, pipelineId, stageId }
 *
 * Moves an opportunity between stages. Any signed-in account can do this
 * — dragging a deal forward is ordinary CRM work, not an admin action —
 * but the shared environment token cannot, since a stage change should be
 * attributable to a person.
 */
export const PATCH = externalWrite(async ({ auth, body }) => {
  const subAccount = String(body.subAccount ?? '').trim()
  const opportunityId = String(body.opportunityId ?? '').trim()
  const pipelineId = String(body.pipelineId ?? '').trim()
  const stageId = String(body.stageId ?? '').trim()

  if (!opportunityId || !stageId || !pipelineId) {
    throw new WriteError('opportunityId, pipelineId and stageId are required.')
  }

  const { subaccounts } = await listSubAccounts()
  const target = subAccount
    ? subaccounts.find((s) => s.vaultName === subAccount)
    : subaccounts[0]
  if (!target) throw new WriteError('Unknown sub-account.', 404)

  try {
    await updateOpportunityStage(target.vaultName, opportunityId, {
      pipelineId,
      pipelineStageId: stageId,
    })
  } catch (err) {
    // Pass GHL's reason through — "which stage rejected it" is the whole
    // question when a move fails, and a generic error sends you to the
    // wrong place.
    throw new WriteError(
      err instanceof Error ? err.message : 'GoHighLevel rejected the move.',
      502,
    )
  }

  console.log(
    `[opportunity-move] ${auth.user.email} moved ${opportunityId} to stage ${stageId} in ${target.vaultName}`,
  )

  return { opportunityId, stageId }
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
