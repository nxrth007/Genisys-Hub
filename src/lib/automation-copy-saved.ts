import { AUTOMATION_IDS, AUTOMATION_INPUT_KEYS, type AutomationInputs } from '@/lib/automation-copy'

/** What staff typed or ticked on a client's Automation Copy board (AppSetting `automationCopy.client.<id>`). */
export type SavedCopy = { values: Partial<AutomationInputs>; done: string[]; updatedAt: string | null }

export const AUTOMATION_COPY_PREFIX = 'automationCopy.client.'
const MAX_VALUE = 500

export function parseSavedCopy(raw: string | null | undefined): SavedCopy {
  try {
    const p = raw ? (JSON.parse(raw) as Partial<SavedCopy>) : {}
    return cleanSavedCopy(p)
  } catch {
    return { values: {}, done: [], updatedAt: null }
  }
}

/** Keep only known keys and automation ids, trimmed to size. */
export function cleanSavedCopy(p: { values?: unknown; done?: unknown; updatedAt?: unknown }): SavedCopy {
  const values: Partial<AutomationInputs> = {}
  if (p.values && typeof p.values === 'object') {
    for (const k of AUTOMATION_INPUT_KEYS) {
      const val = (p.values as Record<string, unknown>)[k]
      if (typeof val === 'string') values[k] = val.slice(0, MAX_VALUE)
    }
  }
  const known = new Set(AUTOMATION_IDS)
  const done = Array.isArray(p.done) ? p.done.filter((d): d is string => typeof d === 'string' && known.has(d)) : []
  return { values, done: [...new Set(done)], updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : null }
}
