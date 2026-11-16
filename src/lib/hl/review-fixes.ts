/**
 * Once: the review workflows that sub-accounts already have are brought up to ./review-kit.ts
 * (2026-11-16), the changes a new sub-account's kit now starts with:
 * - Review Request Campaign: a job moved to Job Completed starts it too, one run per customer at a time;
 * - Review Request Reactivation Campaign: no gift-card draw for reviews;
 * - Database Reactivation: its $100-off texts are promotions (only to people who agreed to those).
 *
 * Each workflow is patched in place, step by step: wording a person changed stays theirs, a workflow
 * someone rebuilt is left alone (and logged), and a run under way keeps its place. The whole kit is
 * NOT applied again (that would rewrite any unused workflow a person had edited).
 */
import type { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/prisma'
import { asSteps, asTriggers } from './automation'
import { CUSTOMER_PIPELINE } from './client-kit'
import { patchPromotions, patchReactivation, patchReviewRequest } from './review-kit'

const KEY = 'hl.reviewFixes.v1'
const TEMPLATES = ['review_request', 'review_reactivation', 'db_reactivation']
let settled = false

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const json = (v: unknown) => v as Prisma.InputJsonValue

export async function maybeFixReviewWorkflows(): Promise<number> {
  if (settled) return 0
  if (await prisma.appSetting.findUnique({ where: { key: KEY }, select: { id: true } })) {
    settled = true
    return 0
  }
  try {
    await prisma.appSetting.create({ data: { key: KEY, value: 'running' } })
  } catch {
    return 0 // another container got there first
  }
  settled = true
  let changed = 0
  const kept: string[] = []
  try {
    const workflows = await prisma.hlWorkflow.findMany({
      where: { deletedAt: null, template: { in: TEMPLATES } },
      select: { id: true, accountId: true, template: true, name: true, trigger: true, triggers: true, steps: true, meta: true, account: { select: { name: true } } },
    })
    for (const w of workflows) {
      const steps = asSteps(w.steps)
      if (w.template === 'review_request') {
        // The pipeline its own opportunity step uses, else the sub-account's Customer Pipeline.
        const own = steps.find((s) => s.id === 'rr_opp')?.config?.pipelineId
        const pipelineId = own ?? (await prisma.hlPipeline.findFirst({ where: { accountId: w.accountId, name: CUSTOMER_PIPELINE }, select: { id: true } }))?.id ?? null
        const p = patchReviewRequest({ triggers: asTriggers(w), steps, meta: rec(w.meta) }, pipelineId)
        if (p.changed) {
          await prisma.hlWorkflow.update({ where: { id: w.id }, data: { trigger: json(p.value.triggers[0]), triggers: json(p.value.triggers), steps: json(p.value.steps), meta: json(p.value.meta) } })
          changed++
        } else if (p.note !== 'already up to date') kept.push(`${w.account.name}: ${w.name} (${p.note})`)
        continue
      }
      const p = w.template === 'review_reactivation' ? patchReactivation(steps) : patchPromotions(steps)
      if (p.changed) {
        await prisma.hlWorkflow.update({ where: { id: w.id }, data: { steps: json(p.value) } })
        changed++
      }
    }
    if (kept.length) console.log(`[review-fixes] left as they are:\n  ${kept.join('\n  ')}`)
    await prisma.appSetting.update({ where: { key: KEY }, data: { value: `done ${new Date().toISOString()}: ${changed} of ${workflows.length} workflows updated, ${kept.length} left as they are`.slice(0, 500) } })
  } catch (err) {
    await prisma.appSetting.update({ where: { key: KEY }, data: { value: `failed ${new Date().toISOString()} after ${changed}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500) } }).catch(() => undefined)
    throw err
  }
  return changed
}
