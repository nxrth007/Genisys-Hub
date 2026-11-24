/**
 * Once (2026-11-24): every client sub-account's "SMS Hard Opt Out -> Update Date - DND" workflow gets the
 * reply trigger ./optout-kit.ts describes: texting goes off only when the whole reply is an opt-out ("No",
 * "Not interested", "Stop"…), not whenever "no" or "stop" appears ("No problem", "Can you stop by?").
 *
 * Only that one trigger is replaced, in place, like ./review-fixes.ts: a workflow whose reply words someone
 * changed, or that was rebuilt without the trigger, is left alone (and logged). The whole kit is NOT applied
 * again (that would rewrite any unused workflow a person had edited), and KIT_VERSION doesn't change.
 */
import type { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/prisma'
import { asTriggers } from './automation'
import { patchOptoutTriggers } from './optout-kit'

const KEY = 'hl.optoutFix.v1'
let settled = false

const json = (v: unknown) => v as Prisma.InputJsonValue

export async function maybeFixOptoutTriggers(): Promise<number> {
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
      where: { deletedAt: null, template: 'a2p_hard_optout' },
      select: { id: true, name: true, trigger: true, triggers: true, account: { select: { name: true } } },
    })
    for (const w of workflows) {
      const p = patchOptoutTriggers(asTriggers(w))
      if (p.changed) {
        await prisma.hlWorkflow.update({ where: { id: w.id }, data: { trigger: json(p.value[0]), triggers: json(p.value) } })
        changed++
      } else if (p.note !== 'already up to date') kept.push(`${w.account.name}: ${w.name} (${p.note})`)
    }
    if (kept.length) console.log(`[optout-fixes] left as they are:\n  ${kept.join('\n  ')}`)
    await prisma.appSetting.update({ where: { key: KEY }, data: { value: `done ${new Date().toISOString()}: ${changed} of ${workflows.length} workflows updated, ${kept.length} left as they are`.slice(0, 500) } })
  } catch (err) {
    await prisma.appSetting.update({ where: { key: KEY }, data: { value: `failed ${new Date().toISOString()} after ${changed}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500) } }).catch(() => undefined)
    throw err
  }
  return changed
}
