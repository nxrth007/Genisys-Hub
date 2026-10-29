import { prisma } from '@/lib/prisma'
import { seoPausedByEnv } from './pause-env'

/**
 * Global "pause all SEO automation" kill switch.
 *
 * On when env SEO_PAUSED is truthy OR the AppSetting `seo.paused` holds
 * `{"paused": true}`. Paused means nothing SEO runs: no tick, no watchers,
 * no manual runs or publishes. Nothing is canceled or deleted; unpausing
 * resumes queued/running runs where they left off.
 */

export const PAUSE_KEY = 'seo.paused'
const CACHE_MS = 30_000

export class SeoPausedError extends Error {
  constructor() {
    super('SEO automation is paused. Resume it on the SEO page (or unset SEO_PAUSED) first.')
    this.name = 'SeoPausedError'
  }
}

export type SeoPauseState = { paused: boolean; source: 'env' | 'setting' | null; pausedAt: string | null; pausedBy: string | null }

type Stored = { paused?: boolean; at?: string; by?: string }
const g = globalThis as unknown as { __seoPauseCache?: { at: number; value: Stored } }

async function readStored(fresh = false): Promise<Stored> {
  const c = g.__seoPauseCache
  if (!fresh && c && Date.now() - c.at < CACHE_MS) return c.value
  let value: Stored = {}
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: PAUSE_KEY } })
    if (row) value = JSON.parse(row.value) as Stored
  } catch (err) {
    // Fail open to the last known value rather than flapping.
    if (c) return c.value
    console.error('[seo] reading pause flag failed:', err)
  }
  g.__seoPauseCache = { at: Date.now(), value }
  return value
}

/** True when all SEO automation must stop. Env check is sync; the DB flag is cached ~30 s. */
export async function seoPaused(): Promise<boolean> {
  if (seoPausedByEnv()) return true
  return (await readStored()).paused === true
}

export async function seoPauseState(): Promise<SeoPauseState> {
  const stored = await readStored()
  if (seoPausedByEnv()) return { paused: true, source: 'env', pausedAt: null, pausedBy: null }
  if (stored.paused === true) return { paused: true, source: 'setting', pausedAt: stored.at ?? null, pausedBy: stored.by ?? null }
  return { paused: false, source: null, pausedAt: null, pausedBy: null }
}

/** Set the AppSetting flag (the env var, if set, still wins). */
export async function setSeoPaused(paused: boolean, by: string): Promise<SeoPauseState> {
  const value: Stored = { paused, at: new Date().toISOString(), by }
  await prisma.appSetting.upsert({
    where: { key: PAUSE_KEY },
    create: { key: PAUSE_KEY, value: JSON.stringify(value) },
    update: { value: JSON.stringify(value) },
  })
  g.__seoPauseCache = { at: Date.now(), value }
  return seoPauseState()
}

/** Throw SeoPausedError when paused (manual entry points). */
export async function assertSeoNotPaused(): Promise<void> {
  if (await seoPaused()) throw new SeoPausedError()
}
