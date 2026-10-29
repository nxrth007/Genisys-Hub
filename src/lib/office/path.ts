/**
 * Grid pathfinding for the office bots: BFS over 4-neighbour cells (axis-
 * aligned moves only), so paths are straight runs with sharp 90-degree
 * turns. Pure, deterministic and dependency-free (unit-tested).
 */
export type Cell = { x: number; y: number }

export type Grid = { width: number; height: number; blocked: (x: number, y: number) => boolean }

const DIRS: readonly Cell[] = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
]

export const cellKey = (c: Cell) => `${c.x},${c.y}`

export function inBounds(g: Grid, c: Cell) {
  return c.x >= 0 && c.y >= 0 && c.x < g.width && c.y < g.height
}

export function walkable(g: Grid, c: Cell) {
  return inBounds(g, c) && !g.blocked(c.x, c.y)
}

/**
 * Shortest path from `start` to `goal` (inclusive of both), or null when
 * unreachable. Ties prefer keeping the current direction, which keeps the
 * number of turns low. Start/goal may themselves be blocked cells (a bot
 * already standing somewhere odd still gets out).
 */
export function findPath(g: Grid, start: Cell, goal: Cell): Cell[] | null {
  if (!inBounds(g, start) || !inBounds(g, goal)) return null
  if (start.x === goal.x && start.y === goal.y) return [start]
  const W = g.width
  const idx = (c: Cell) => c.y * W + c.x
  // State = cell + incoming direction so that ties favour straight runs.
  const prev = new Map<number, number>()
  const sKey = idx(start) * 5 + 4
  // 0-1 BFS on (cell, dir): moving costs 1000, turning adds 1.
  const deque: number[] = [sKey]
  const cost = new Map<number, number>([[sKey, 0]])
  let found: number | null = null
  while (deque.length) {
    // Dijkstra-lite: pick the lowest-cost entry (grids here are tiny).
    let bi = 0
    for (let i = 1; i < deque.length; i++) if (cost.get(deque[i])! < cost.get(deque[bi])!) bi = i
    const cur = deque.splice(bi, 1)[0]
    const curCost = cost.get(cur)!
    const ci = Math.floor(cur / 5)
    const cd = cur % 5
    const cx = ci % W
    const cy = Math.floor(ci / W)
    if (cx === goal.x && cy === goal.y) {
      found = cur
      break
    }
    for (let d = 0; d < 4; d++) {
      const n = { x: cx + DIRS[d].x, y: cy + DIRS[d].y }
      if (!inBounds(g, n)) continue
      const isGoal = n.x === goal.x && n.y === goal.y
      if (!isGoal && g.blocked(n.x, n.y)) continue
      const nk = idx(n) * 5 + d
      const nc = curCost + 1000 + (cd !== 4 && cd !== d ? 1 : 0)
      if (!cost.has(nk) || nc < cost.get(nk)!) {
        cost.set(nk, nc)
        prev.set(nk, cur)
        deque.push(nk)
      }
    }
  }
  if (found === null) return null
  const out: Cell[] = []
  for (let k: number | undefined = found; k !== undefined; k = prev.get(k)) {
    const ci = Math.floor(k / 5)
    out.push({ x: ci % W, y: Math.floor(ci / W) })
  }
  return out.reverse()
}

/** Keep only start, every corner, and the goal. */
export function corners(path: Cell[]): Cell[] {
  if (path.length <= 2) return path.slice()
  const out = [path[0]]
  for (let i = 1; i < path.length - 1; i++) {
    const a = path[i - 1]
    const b = path[i]
    const c = path[i + 1]
    if (b.x - a.x !== c.x - b.x || b.y - a.y !== c.y - b.y) out.push(b)
  }
  out.push(path[path.length - 1])
  return out
}

/** Total Manhattan length of a corner list. */
export function pathLength(pts: Cell[]): number {
  let n = 0
  for (let i = 1; i < pts.length; i++) n += Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y)
  return n
}

/** Position `dist` cells along a corner list (fractional cells). */
export function pointAlong(pts: Cell[], dist: number): Cell {
  if (!pts.length) return { x: 0, y: 0 }
  let left = Math.max(0, dist)
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const seg = Math.abs(b.x - a.x) + Math.abs(b.y - a.y)
    if (left <= seg) {
      const f = seg === 0 ? 0 : left / seg
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
    }
    left -= seg
  }
  return pts[pts.length - 1]
}
