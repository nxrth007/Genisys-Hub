import { prisma } from '@/lib/prisma'
import { nextHidden, readHiddenMap, type HiddenMap } from './hide-plan'

/**
 * Which Office requests and questions a person has hidden from their own view (./hide-plan.ts),
 * kept in an AppSetting per person. Hiding never answers anything.
 */
const keyFor = (who: string) => `office.hidden:${who.trim().toLowerCase()}`

export async function readHidden(who: string | null | undefined): Promise<HiddenMap> {
  if (!who?.trim()) return {}
  const row = await prisma.appSetting.findUnique({ where: { key: keyFor(who) } }).catch(() => null)
  return readHiddenMap(row?.value)
}

export async function setHidden(who: string, change: { id: string; sig: string; hidden: boolean }): Promise<HiddenMap> {
  const key = keyFor(who)
  const row = await prisma.appSetting.findUnique({ where: { key } })
  const next = nextHidden(readHiddenMap(row?.value), change)
  const value = JSON.stringify(next)
  await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
  return next
}
