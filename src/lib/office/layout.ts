/**
 * The office floor plan on a 22 x 16 grid (x runs to the screen's lower
 * right, y to the lower left in the isometric view; (0,0) is the far
 * corner). Pure data + helpers, shared by the scene and the tests.
 */
import type { Cell, Grid } from './path'
import type { BotId } from './mapping'

export const GRID_W = 22
export const GRID_H = 16

export type ItemKind =
  | 'desk'
  | 'bigdesk'
  | 'glass'
  | 'plant'
  | 'sofa'
  | 'coffee'
  | 'rug'
  | 'meeting'
  | 'counter'
  | 'fridge'
  | 'bartable'

export type Item = { id: string; kind: ItemKind; x: number; y: number; w: number; d: number; blocks: boolean; axis?: 'x' | 'y' }

const it = (id: string, kind: ItemKind, x: number, y: number, w = 1, d = 1, blocks = true): Item => ({ id, kind, x, y, w, d, blocks })

/** Glass partition run with optional door cells left open. */
function glassRun(id: string, x: number, y: number, len: number, axis: 'x' | 'y', doors: number[] = []): Item[] {
  const out: Item[] = []
  for (let i = 0; i < len; i++) {
    if (doors.includes(i)) continue
    out.push({ ...(axis === 'x' ? it(`${id}-${i}`, 'glass', x + i, y) : it(`${id}-${i}`, 'glass', x, y + i)), axis })
  }
  return out
}

export type Desk = { id: string; label: string; item: Item; seat: Cell }

const desk = (id: string, label: string, x: number, y: number, seat: Cell, kind: ItemKind = 'desk', w = 2): Desk => ({
  id,
  label,
  item: it(id, kind, x, y, w, 1),
  seat,
})

/** Desk 0 is the Chief of Staff's office; the rest follow ROSTER order. */
export const DESKS: Desk[] = [
  desk('desk-cos', 'Chief of Staff office', 1, 1, { x: 2, y: 2 }, 'bigdesk', 3),
  // 2 x 2 pod on the right (back-to-back rows).
  desk('desk-pod-1', 'Pod A1', 13, 8, { x: 13, y: 7 }),
  desk('desk-pod-2', 'Pod A2', 15, 8, { x: 16, y: 7 }),
  desk('desk-pod-3', 'Pod A3', 13, 9, { x: 13, y: 10 }),
  desk('desk-pod-4', 'Pod A4', 15, 9, { x: 16, y: 10 }),
  // Two standalone desks centre-left.
  desk('desk-solo-1', 'Open floor 1', 7, 6, { x: 7, y: 7 }),
  desk('desk-solo-2', 'Open floor 2', 7, 9, { x: 8, y: 10 }),
  // Row along the back wall.
  desk('desk-row-1', 'Window row 1', 6, 1, { x: 6, y: 2 }),
  desk('desk-row-2', 'Window row 2', 9, 1, { x: 9, y: 2 }),
  desk('desk-row-3', 'Window row 3', 12, 1, { x: 12, y: 2 }),
]

export const ITEMS: Item[] = [
  // Rugs first (non-blocking floor decals).
  it('rug-lounge', 'rug', 0, 10, 6, 6, false),
  it('rug-meeting', 'rug', 15, 0, 7, 5, false),
  // Chief of Staff office (top-left) — glass on two sides, door at y=3.
  ...glassRun('g-cos-x', 5, 0, 7, 'y', [3]),
  ...glassRun('g-cos-y', 0, 6, 5, 'x'),
  // Meeting room (top-right) — glass, doors at y=2 and x=18.
  ...glassRun('g-meet-y', 14, 0, 6, 'y', [2]),
  ...glassRun('g-meet-x', 15, 5, 7, 'x', [3]),
  it('meeting-table', 'meeting', 16, 1, 4, 2),
  // Lounge (bottom-left): L sofa, glass coffee table.
  it('sofa-a', 'sofa', 0, 11, 1, 5),
  it('sofa-b', 'sofa', 1, 15, 3, 1),
  it('coffee', 'coffee', 2, 12, 2, 2),
  // Breakroom (bottom-right).
  it('counter-a', 'counter', 18, 15, 3, 1),
  it('counter-b', 'counter', 21, 12, 1, 4),
  it('fridge', 'fridge', 21, 10, 1, 1),
  it('bartable', 'bartable', 18, 12, 2, 1),
  // Plants.
  it('plant-1', 'plant', 4, 0),
  it('plant-2', 'plant', 13, 0),
  it('plant-3', 'plant', 0, 9),
  it('plant-4', 'plant', 21, 6),
  it('plant-5', 'plant', 10, 15),
  it('plant-6', 'plant', 11, 6),
  it('plant-7', 'plant', 0, 7),
  ...DESKS.map((d) => d.item),
]

/** Wall screen above the meeting room's back wall (cells along y = 0). */
export const WALL_SCREEN = { x: 16.3, len: 3.4 }

/** Where idle bots hang out (lounge + breakroom), in preference order. */
export const IDLE_SPOTS: Cell[] = [
  { x: 1, y: 12 },
  { x: 4, y: 12 },
  { x: 1, y: 14 },
  { x: 4, y: 14 },
  { x: 3, y: 11 },
  { x: 18, y: 13 },
  { x: 20, y: 13 },
  { x: 19, y: 11 },
  { x: 2, y: 14 },
  { x: 17, y: 14 },
]

/** Visitors stand here in the Chief of Staff office. */
export const COS_VISIT: Cell = { x: 3, y: 3 }
export const MEETING_SPOTS: Cell[] = [
  { x: 16, y: 3 },
  { x: 19, y: 3 },
  { x: 15, y: 1 },
  { x: 20, y: 1 },
]

const blockedSet = new Set<string>()
for (const i of ITEMS) {
  if (!i.blocks) continue
  for (let x = i.x; x < i.x + i.w; x++) for (let y = i.y; y < i.y + i.d; y++) blockedSet.add(`${x},${y}`)
}

export const GRID: Grid = { width: GRID_W, height: GRID_H, blocked: (x, y) => blockedSet.has(`${x},${y}`) }

export function deskFor(botIndex: number): Desk | null {
  return DESKS[botIndex] ?? null
}

/** Free cell next to another bot's seat, for a visiting bot. */
export function visitSpot(target: Cell): Cell {
  const opts = [
    { x: target.x + 1, y: target.y },
    { x: target.x - 1, y: target.y },
    { x: target.x, y: target.y + 1 },
    { x: target.x, y: target.y - 1 },
  ]
  return opts.find((c) => c.x >= 0 && c.y >= 0 && c.x < GRID_W && c.y < GRID_H && !GRID.blocked(c.x, c.y)) ?? target
}

export type DeskAssignment = Record<BotId, Desk>
