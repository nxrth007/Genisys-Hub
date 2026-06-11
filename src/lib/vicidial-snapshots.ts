/**
 * Daily Vicidial list snapshots — the burn-down ledger behind
 * /leads. Lists are a depleting resource (the dialer consumes NEW
 * leads every shift); one snapshot per list per UTC day gives the
 * Hub enough history to show "NEW is dropping ~800/day, this list
 * is dry in 3 weeks."
 *
 * Two entry points:
 *   - snapshotAllVicidialLists(): scheduler's daily tick. Walks the
 *     Show Lists page, fetches per-list stats, upserts one row per
 *     (list, today).
 *   - ensureTodaySnapshot(listId): lazy single-list variant called
 *     from the snapshots API so the chart includes today even if
 *     the daily tick hasn't fired yet (fresh deploys, restarts).
 *
 * Upsert by (listId, snapshotDay) — re-runs refresh the same row,
 * so the daily tick and the lazy path never duplicate.
 */
import { prisma } from './prisma'
import {
  fetchVicidialLists,
  fetchVicidialListStats,
} from './vicidial-lists'

function utcToday(): string {
  return new Date().toISOString().slice(0, 10)
}

async function writeSnapshot(listId: string): Promise<boolean> {
  const stats = await fetchVicidialListStats(listId)
  if (!stats.ok) {
    console.error(
      `[vicidial-snapshots] stats fetch failed for list ${listId}: ${stats.error}`,
    )
    return false
  }
  const newRow = stats.statuses.find((s) => s.status === 'NEW')
  const day = utcToday()
  await prisma.vicidialListSnapshot.upsert({
    where: {
      listId_snapshotDay: { listId, snapshotDay: day },
    },
    create: {
      listId,
      snapshotDay: day,
      total: stats.total,
      newCount: newRow?.subtotal ?? null,
      statusJson: stats.statuses,
    },
    update: {
      total: stats.total,
      newCount: newRow?.subtotal ?? null,
      statusJson: stats.statuses,
    },
  })
  return true
}

export async function snapshotAllVicidialLists(): Promise<{
  snapshotted: number
  failed: number
}> {
  const lists = await fetchVicidialLists()
  if (!lists.ok) {
    console.error(`[vicidial-snapshots] lists fetch failed: ${lists.error}`)
    return { snapshotted: 0, failed: 0 }
  }
  let snapshotted = 0
  let failed = 0
  for (const l of lists.lists) {
    try {
      ;(await writeSnapshot(l.listId)) ? snapshotted++ : failed++
    } catch (err) {
      console.error(
        `[vicidial-snapshots] snapshot failed for list ${l.listId}:`,
        err,
      )
      failed++
    }
  }
  return { snapshotted, failed }
}

export async function ensureTodaySnapshot(listId: string): Promise<void> {
  const existing = await prisma.vicidialListSnapshot.findUnique({
    where: {
      listId_snapshotDay: { listId, snapshotDay: utcToday() },
    },
    select: { id: true },
  })
  if (existing) return
  await writeSnapshot(listId)
}
