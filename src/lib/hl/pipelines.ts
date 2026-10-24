import { HlInputError } from './http'
import type { HlStage } from './types'

/** Stage list from a request: names kept in order, ids kept when given (opportunities point at them), new ones made up. */
export function cleanStages(raw: unknown): HlStage[] {
  if (!Array.isArray(raw)) throw new HlInputError('Give the pipeline at least one stage.')
  const seen = new Set<string>()
  const stages: HlStage[] = []
  for (const s of raw) {
    const name = typeof s?.name === 'string' ? s.name.trim().slice(0, 60) : ''
    if (!name) continue
    let id = typeof s?.id === 'string' && /^[a-z0-9_-]{1,40}$/i.test(s.id) ? s.id : name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'stage'
    while (seen.has(id)) id = `${id}-${seen.size}`
    seen.add(id)
    stages.push({ id, name })
  }
  if (!stages.length) throw new HlInputError('Give the pipeline at least one stage.')
  return stages
}
