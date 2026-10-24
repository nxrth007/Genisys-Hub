import type { HlStep } from './types'

/**
 * Workflow steps as a tree, the way GHL lays them out. A builder-made
 * workflow is a plain list that runs top to bottom; an imported one (or a
 * plain one once edited here) links each step to the next, and If/Else and
 * Split steps fork into branches that each run to their own END.
 */

/** Same test the engine uses: steps that link to each other rather than run in list order. */
export const isLinked = (steps: HlStep[]) => steps.some((s) => s.next !== undefined || s.type === 'if_else' || s.type === 'goto' || s.type === 'split')

/** The workflow with every step pointing at the one after it (linked ones as they are). The first step is where a run starts. */
export function linked(steps: HlStep[]): HlStep[] {
  if (isLinked(steps)) return steps
  return steps.map((s, i) => ({ ...s, next: steps[i + 1]?.id ?? null }))
}

/** A place a step can go: before the first step, after a step, or at the top of a branch. */
export type Slot =
  | { kind: 'start' }
  | { kind: 'after'; id: string }
  | { kind: 'branch'; id: string; branch: string }
  | { kind: 'else'; id: string }
  | { kind: 'path'; id: string; path: string }

/** The step a slot leads to now. */
function slotTarget(steps: HlStep[], slot: Slot): string | null {
  if (slot.kind === 'start') return steps[0]?.id ?? null
  const s = steps.find((x) => x.id === slot.id)
  if (!s) return null
  if (slot.kind === 'after') return s.next ?? null
  if (slot.kind === 'else') return s.elseNext ?? null
  if (slot.kind === 'branch') return s.branches?.find((b) => b.id === slot.branch)?.next ?? null
  return s.config.paths?.find((p) => p.id === slot.path)?.next ?? null
}

/** Every link out of a step (not Go-to jumps, which point back up the tree). */
function links(s: HlStep): (string | null | undefined)[] {
  return [s.next, ...(s.branches ?? []).map((b) => b.next), s.elseNext, ...(s.config.paths ?? []).map((p) => p.next)]
}

/** The step with each link that `map` changes swapped. */
function relink(s: HlStep, map: (to: string | null | undefined) => string | null | undefined): HlStep {
  const out: HlStep = { ...s }
  if (s.next !== undefined) out.next = map(s.next) ?? null
  if (s.branches) out.branches = s.branches.map((b) => ({ ...b, next: map(b.next) ?? null }))
  if (s.elseNext !== undefined) out.elseNext = map(s.elseNext) ?? null
  if (s.config.paths) out.config = { ...s.config, paths: s.config.paths.map((p) => ({ ...p, next: map(p.next) ?? null })) }
  return out
}

/** Put `step` at `slot`: it takes over what the slot led to, so the rest of the path follows it. */
export function insertStep(steps: HlStep[], slot: Slot, step: HlStep): HlStep[] {
  const g = linked(steps)
  const added: HlStep = { ...step, next: slotTarget(g, slot) }
  if (slot.kind === 'start') return [added, ...g]
  const at = g.findIndex((s) => s.id === slot.id)
  if (at < 0) return g
  const out = g.map((s) => {
    if (s.id !== slot.id) return s
    if (slot.kind === 'after') return { ...s, next: added.id }
    if (slot.kind === 'else') return { ...s, elseNext: added.id }
    if (slot.kind === 'branch') return { ...s, branches: (s.branches ?? []).map((b) => (b.id === slot.branch ? { ...b, next: added.id } : b)) }
    return { ...s, config: { ...s.config, paths: (s.config.paths ?? []).map((p) => (p.id === slot.path ? { ...p, next: added.id } : p)) } }
  })
  out.splice(at + 1, 0, added)
  return out
}

/** The steps under a step's links, all the way down. */
export function below(steps: HlStep[], id: string): Set<string> {
  const byId = new Map(steps.map((s) => [s.id, s]))
  const out = new Set<string>()
  const queue = links(byId.get(id) ?? ({ config: {} } as HlStep)).filter((x): x is string => !!x)
  while (queue.length) {
    const next = queue.shift()!
    if (out.has(next) || next === id) continue
    out.add(next)
    const s = byId.get(next)
    if (s) queue.push(...links(s).filter((x): x is string => !!x))
  }
  return out
}

/** Branch and Split steps (and a GHL step that forks) take their branches with them. */
export const forks = (s: HlStep) => s.type === 'if_else' || s.type === 'split' || (s.type === 'ghl' && !!s.config.paths?.length)

/**
 * Take a step out. The path closes up behind an ordinary step; a branching
 * step goes with everything on its branches. Links and Go-tos to anything
 * removed end the path there instead.
 */
export function removeStep(steps: HlStep[], id: string): HlStep[] {
  const g = linked(steps)
  const s = g.find((x) => x.id === id)
  if (!s) return g
  const drop = forks(s) ? new Set([id, ...below(g, id)]) : new Set([id])
  const to = forks(s) ? null : (s.next ?? null)
  let out = g
    .filter((x) => !drop.has(x.id))
    .map((x) => relink(x, (v) => (v === id ? to : v && drop.has(v) ? null : v)))
    .map((x) => (x.type === 'goto' && x.config.target && drop.has(x.config.target) ? { ...x, config: { ...x.config, target: undefined } } : x))
  // The first step is where runs start, so whatever took the removed start's place goes first.
  if (g[0]?.id === id && to) {
    const first = out.find((x) => x.id === to)
    if (first) out = [first, ...out.filter((x) => x.id !== to)]
  }
  return out
}

export type FlowArm = { key: string; label: string; percent?: number; slot: Slot; chain: FlowChain }
export type FlowNode = { step: HlStep; arms?: FlowArm[]; jump?: string | null }
/** A run of steps down one path: it ends (END), forks (its last node has arms), jumps (Go to), or runs into a step drawn elsewhere. */
export type FlowChain = { nodes: FlowNode[]; end: boolean; joins?: string }

/** The tree to draw: from the first step down every branch, plus any steps nothing leads to. */
export function flow(steps: HlStep[]): { chain: FlowChain; loose: HlStep[] } {
  const g = linked(steps)
  const byId = new Map(g.map((s) => [s.id, s]))
  const seen = new Set<string>()
  const chainFrom = (first: string | null | undefined): FlowChain => {
    const nodes: FlowNode[] = []
    let id = first ?? null
    while (id) {
      const s = byId.get(id)
      if (!s) break
      if (seen.has(id)) return { nodes, end: false, joins: id }
      seen.add(id)
      if (s.type === 'if_else') {
        const arms: FlowArm[] = (s.branches ?? []).map((b) => ({ key: b.id, label: b.name, slot: { kind: 'branch', id: s.id, branch: b.id }, chain: chainFrom(b.next) }))
        arms.push({ key: 'else', label: s.elseName || 'None', slot: { kind: 'else', id: s.id }, chain: chainFrom(s.elseNext) })
        nodes.push({ step: s, arms })
        return { nodes, end: false }
      }
      if (s.type === 'split' || (s.type === 'ghl' && s.config.paths?.length)) {
        nodes.push({
          step: s,
          arms: (s.config.paths ?? []).map((p) => ({
            key: p.id,
            label: p.name,
            ...(s.type === 'split' ? { percent: p.percent } : {}),
            slot: { kind: 'path', id: s.id, path: p.id },
            chain: chainFrom(p.next),
          })),
        })
        return { nodes, end: false }
      }
      if (s.type === 'goto') {
        nodes.push({ step: s, jump: s.config.target ?? null })
        return { nodes, end: false }
      }
      nodes.push({ step: s })
      id = s.next ?? null
    }
    return { nodes, end: true }
  }
  const chain = chainFrom(g[0]?.id)
  return { chain, loose: g.filter((s) => !seen.has(s.id)) }
}
