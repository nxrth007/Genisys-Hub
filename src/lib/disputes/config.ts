/**
 * Dispute defense settings. The environment supplies the defaults
 * (dry-run, refunds off, milestone emails off). A saved AppSetting
 * overrides them, except the dry-run kill switch, which always wins.
 */
import { prisma } from '@/lib/prisma'
import { parseDisputeConfig, type DisputeConfig } from './plan'

const CONFIG_KEY = 'disputes.config'
const TEMPLATE_KEY = 'disputes.templates'

export async function loadDisputeConfig(): Promise<DisputeConfig> {
  const row = await prisma.appSetting.findUnique({ where: { key: CONFIG_KEY } }).catch(() => null)
  let stored: Partial<DisputeConfig> | null = null
  if (row) {
    try {
      stored = JSON.parse(row.value) as Partial<DisputeConfig>
    } catch {
      stored = null
    }
  }
  return parseDisputeConfig(process.env, stored)
}

export async function saveDisputeConfig(patch: Partial<DisputeConfig>): Promise<DisputeConfig> {
  const current = await loadDisputeConfig()
  const next = { ...current, ...patch, forceDryRun: current.forceDryRun }
  await prisma.appSetting.upsert({
    where: { key: CONFIG_KEY },
    create: { key: CONFIG_KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  })
  return loadDisputeConfig()
}

export async function loadTemplates(): Promise<Record<string, string>> {
  const row = await prisma.appSetting.findUnique({ where: { key: TEMPLATE_KEY } }).catch(() => null)
  if (!row) return {}
  try {
    const v = JSON.parse(row.value) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Record<string, string> = {}
    for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val
    return out
  } catch {
    return {}
  }
}

export async function saveTemplate(reason: string, body: string): Promise<void> {
  const all = await loadTemplates()
  all[reason] = body
  const value = JSON.stringify(all)
  await prisma.appSetting.upsert({ where: { key: TEMPLATE_KEY }, create: { key: TEMPLATE_KEY, value }, update: { value } })
}
