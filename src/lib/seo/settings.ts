import { prisma } from '@/lib/prisma'
import type { SeoSettings } from './api-types'

/**
 * SEO engine settings, stored as one JSON AppSetting so they change from
 * the Hub without a deploy.
 *
 * The weekly schedule defaults OFF: the scheduler also runs under
 * `next dev`, and a local server must never start committing to client
 * repos on its own. Manual runs work whether or not it's on.
 */

const KEY = 'seo.settings'

export const SEO_DEFAULTS: SeoSettings = {
  enabled: false,
  weekday: 1, // Monday
  hour: 6,
  timeZone: 'America/New_York',
  // The claude-api reference's default model. Change here (or in the stored
  // setting) — every call reads it per run.
  model: 'claude-opus-5',
  postsPerWeek: 1,
  maxCostPerRunUsd: 8,
}

function clamp(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : fallback
  return Math.min(hi, Math.max(lo, v))
}

function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function normalize(raw: Partial<SeoSettings>): SeoSettings {
  return {
    enabled: raw.enabled === true,
    weekday: clamp(raw.weekday, 0, 6, SEO_DEFAULTS.weekday),
    hour: clamp(raw.hour, 0, 23, SEO_DEFAULTS.hour),
    timeZone: validTimeZone(raw.timeZone) ? raw.timeZone : SEO_DEFAULTS.timeZone,
    model: typeof raw.model === 'string' && /^claude-[a-z0-9-]+$/.test(raw.model) ? raw.model : SEO_DEFAULTS.model,
    postsPerWeek: clamp(raw.postsPerWeek, 0, 2, SEO_DEFAULTS.postsPerWeek),
    maxCostPerRunUsd:
      typeof raw.maxCostPerRunUsd === 'number' && raw.maxCostPerRunUsd > 0
        ? Math.min(50, Math.round(raw.maxCostPerRunUsd * 100) / 100)
        : SEO_DEFAULTS.maxCostPerRunUsd,
    armedAt: typeof raw.armedAt === 'string' && !Number.isNaN(Date.parse(raw.armedAt)) ? raw.armedAt : undefined,
  }
}

export async function getSeoSettings(): Promise<SeoSettings> {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } })
  if (!row) return { ...SEO_DEFAULTS }
  try {
    return normalize({ ...SEO_DEFAULTS, ...(JSON.parse(row.value) as Partial<SeoSettings>) })
  } catch {
    return { ...SEO_DEFAULTS }
  }
}

export async function updateSeoSettings(patch: Partial<SeoSettings>): Promise<SeoSettings> {
  const current = await getSeoSettings()
  const { armedAt: _ignored, ...rest } = patch
  void _ignored
  const next = normalize({ ...current, ...rest })
  // Turning the schedule on (or moving it) mid-slot must not fire every
  // site at once; the slot that already began is skipped until next week.
  if (
    (next.enabled && !current.enabled) ||
    next.weekday !== current.weekday ||
    next.hour !== current.hour ||
    next.timeZone !== current.timeZone
  ) {
    next.armedAt = new Date().toISOString()
  }
  await prisma.appSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  })
  return next
}

/** Weekday (0–6) and hour (0–23) of `at` in `timeZone`. */
export function zonedParts(at: Date, timeZone: string): { weekday: number; hour: number; ymd: string } {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = Object.fromEntries(f.formatToParts(at).map((p) => [p.type, p.value]))
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return {
    weekday: days.indexOf(parts.weekday),
    // Some engines render midnight as "24".
    hour: Number(parts.hour) % 24,
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
  }
}

/** ISO-8601 week label for a date's calendar day in `timeZone`, e.g. "2026-W40". */
export function isoWeekLabel(at: Date, timeZone: string): string {
  const { ymd } = zonedParts(at, timeZone)
  const [y, m, d] = ymd.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/**
 * The next time the weekly schedule fires, as an ISO string — found by
 * stepping forward hour by hour (≤ 8 days), which stays correct across DST.
 */
export function nextScheduledRun(settings: SeoSettings, from: Date): string | null {
  if (!settings.enabled) return null
  const start = new Date(from)
  start.setUTCMinutes(0, 0, 0)
  for (let i = 1; i <= 24 * 8; i++) {
    const t = new Date(start.getTime() + i * 3_600_000)
    const p = zonedParts(t, settings.timeZone)
    if (p.weekday === settings.weekday && p.hour === settings.hour) return t.toISOString()
  }
  return null
}
