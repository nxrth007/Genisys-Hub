/**
 * Hell-level became Genisys OS on 2026-11-16. Once, what the Hub had already saved under the old
 * name is brought along:
 * - the notes a client's folder shows for their website, number and domain requests ("It's in their
 *   Hell-level → Settings → Domains"), and
 * - each person's hidden Office items. Those are matched by their wording (src/lib/office/hide-plan.ts),
 *   so without this every hidden item that names the product would come back onto the floor.
 * Logs are history and stay as written. Each row keeps its own updated time: nothing here is news.
 */
import { prisma } from '@/lib/prisma'
import { OLD_NAME_PART, renamedText } from './rename-plan'

const KEY = 'hl.renamedToGenisysOs.v1'
let settled = false

export async function maybeRenameSavedNotes(): Promise<number> {
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
  const has = { contains: OLD_NAME_PART }
  const fix = (s: string | null) => (s === null ? null : renamedText(s))
  let changed = 0
  try {
    for (const r of await prisma.hlSiteRequest.findMany({ where: { detail: has }, select: { id: true, detail: true, updatedAt: true } })) {
      await prisma.hlSiteRequest.update({ where: { id: r.id }, data: { detail: fix(r.detail), updatedAt: r.updatedAt } })
      changed++
    }
    for (const r of await prisma.hlNumberRequest.findMany({ where: { OR: [{ detail: has }, { verifyNote: has }] }, select: { id: true, detail: true, verifyNote: true, updatedAt: true } })) {
      await prisma.hlNumberRequest.update({ where: { id: r.id }, data: { detail: fix(r.detail), verifyNote: fix(r.verifyNote), updatedAt: r.updatedAt } })
      changed++
    }
    for (const r of await prisma.hlDomainRequest.findMany({ where: { detail: has }, select: { id: true, detail: true, updatedAt: true } })) {
      await prisma.hlDomainRequest.update({ where: { id: r.id }, data: { detail: fix(r.detail), updatedAt: r.updatedAt } })
      changed++
    }
    // The hidden map is JSON of { id: wording }: the replacement has no quote or backslash, so it stays valid.
    for (const r of await prisma.appSetting.findMany({ where: { key: { startsWith: 'office.hidden:' }, value: has }, select: { id: true, value: true } })) {
      await prisma.appSetting.update({ where: { id: r.id }, data: { value: renamedText(r.value) } })
      changed++
    }
    await prisma.appSetting.update({ where: { key: KEY }, data: { value: `done ${new Date().toISOString()}: ${changed} saved note(s) renamed` } })
  } catch (err) {
    // What was renamed stays renamed; the rest keeps the old name until someone clears this marker to run it again.
    await prisma.appSetting.update({ where: { key: KEY }, data: { value: `failed ${new Date().toISOString()} after ${changed}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500) } }).catch(() => undefined)
    throw err
  }
  return changed
}
