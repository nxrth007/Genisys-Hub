import { prisma } from '@/lib/prisma'
import { hubAlert, hubAlertThrottled, hubLink } from '@/lib/hub-alerts'
import { branchExists, compareCommits, mergeBranchInto, pushEmptyCommit } from './github'
import { lovableChannel, lovableProjectInfo } from './lovable'

/**
 * Keep Lovable and GitHub in step around the engine's merges.
 *
 * Lovable two-way syncs `main` on GitHub's push notification. When one is
 * missed, Lovable doesn't pull the engine's merge; if someone then edits
 * in Lovable, Lovable can't push onto the newer `main` and parks the edits
 * on `lovable-sync` ("merge that branch into main with a merge commit").
 * Both happened on 2026-10-22 (Luxama, Always There Lawn Care).
 *
 *   - Nudge: 15 minutes after an engine merge that Lovable still hasn't
 *     pulled, push one empty commit to `main`. GitHub notifies Lovable
 *     again and it pulls. Once per run.
 *   - Heal: a `lovable-sync` branch with commits `main` lacks is merged
 *     into `main` with a merge commit, as Lovable asks. A conflict is left
 *     for a person, with a Slack alert.
 *
 * Runs from the scheduler; does work at most every 10 minutes.
 */

const EVERY_MS = 10 * 60_000
const NUDGE_AFTER_MS = 15 * 60_000
const NUDGE_UNTIL_MS = 24 * 3_600_000
const SYNC_BRANCH = 'lovable-sync'

let lastRun = 0
let inFlight = false

type PublishSnap = { publish?: { mergeSha?: string; gaveUp?: boolean } }

export async function maybeHealLovableSync(): Promise<{ nudged: number; merged: number; conflicts: number }> {
  const out = { nudged: 0, merged: 0, conflicts: 0 }
  if (process.env.NODE_ENV !== 'production') return out
  if (inFlight || Date.now() - lastRun < EVERY_MS) return out
  lastRun = Date.now()
  inFlight = true
  try {
    const sites = await prisma.seoSite.findMany({
      where: { archivedAt: null, repoFullName: { not: null } },
      select: { id: true, name: true, repoFullName: true, defaultBranch: true, lovableProjectId: true },
    })

    // Heal: edits Lovable parked on lovable-sync.
    for (const s of sites) {
      const repo = s.repoFullName!
      const main = s.defaultBranch || 'main'
      try {
        if (!(await branchExists(repo, SYNC_BRANCH))) continue
        const cmp = await compareCommits(repo, main, SYNC_BRANCH)
        if (cmp.aheadBy === 0) continue
        const r = await mergeBranchInto(repo, main, SYNC_BRANCH, `Merge ${SYNC_BRANCH} into ${main} (Lovable edits it couldn't push directly)`)
        if (r.result === 'merged') {
          out.merged++
          await hubAlert(
            `:twisted_rightwards_arrows: *${s.name}*: Lovable couldn't push to \`${main}\` and parked ${cmp.aheadBy} edit${cmp.aheadBy === 1 ? '' : 's'} on \`${SYNC_BRANCH}\`. The Hub merged them into \`${main}\` (merge commit, nothing lost). <${hubLink(`/seo/${s.id}`)}|SEO>`,
          )
        } else if (r.result === 'conflict') {
          out.conflicts++
          await hubAlertThrottled(
            `lovable-sync-conflict:${repo}`,
            24 * 3_600_000,
            `:warning: *${s.name}*: Lovable parked edits on \`${SYNC_BRANCH}\` in ${repo}, and they conflict with \`${main}\`. A person has to merge \`${SYNC_BRANCH}\` into \`${main}\` on GitHub with a merge commit (no squash, no rebase). Don't edit this site in Lovable until then.`,
          )
        }
      } catch (err) {
        console.warn(`[lovable-sync] ${repo}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // Nudge: engine merges Lovable hasn't pulled.
    if (!(await lovableChannel().catch(() => null))) return out
    const since = new Date(Date.now() - NUDGE_UNTIL_MS)
    const runs = await prisma.seoRun.findMany({
      where: { status: 'awaiting_publish', mergedAt: { gte: since, lte: new Date(Date.now() - NUDGE_AFTER_MS) } },
      select: { id: true, siteId: true, snapshot: true },
    })
    for (const run of runs) {
      const s = sites.find((x) => x.id === run.siteId)
      const mergeSha = (run.snapshot as PublishSnap | null)?.publish?.mergeSha
      if (!s?.lovableProjectId || !mergeSha) continue
      const key = `seo.lovableNudge.${run.id}`
      if (await prisma.appSetting.findUnique({ where: { key } })) continue
      try {
        const info = await lovableProjectInfo(s.lovableProjectId)
        const latest = info?.latestCommitSha ?? null
        if (latest) {
          if (latest.startsWith(mergeSha) || mergeSha.startsWith(latest)) continue
          const cmp = await compareCommits(s.repoFullName!, mergeSha, latest).catch(() => null)
          if (cmp?.status === 'identical' || cmp?.status === 'ahead') continue
        }
        const sha = await pushEmptyCommit(s.repoFullName!, s.defaultBranch || 'main', 'Sync to Lovable')
        await prisma.appSetting.create({ data: { key, value: JSON.stringify({ at: new Date().toISOString(), sha }) } })
        out.nudged++
        console.log(`[lovable-sync] ${s.name}: Lovable hadn't pulled ${mergeSha.slice(0, 7)} after 15 min; pushed ${sha.slice(0, 7)} to notify it again`)
      } catch (err) {
        console.warn(`[lovable-sync] nudge ${s.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return out
  } finally {
    inFlight = false
  }
}
