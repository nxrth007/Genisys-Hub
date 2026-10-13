import type { GscRow, PageTrend, RefreshCandidate } from './types'

/**
 * Which live posts to rewrite this week.
 *
 * A post that's losing clicks or rankings, or sitting just off page one,
 * usually gains more from an update than a new post would — Google rewards
 * pages that stay current and answer what people actually search. Picked
 * from Search Console numbers, not by Claude, and only among the engine's
 * own content files (src/content/blog/<slug>.json), since those are the
 * only pages it can rewrite safely.
 */

/** A post is left alone for this long after it was written or last refreshed. */
export const REFRESH_MIN_AGE_DAYS = 60
/** Refreshes per run, on top of the new posts. */
export const MAX_REFRESHES_PER_RUN = 2

type Scored = RefreshCandidate & { score: number }

function blogSlug(page: string): string | null {
  try {
    const m = new URL(page).pathname.replace(/\/+$/, '').match(/^\/blog\/([a-z0-9-]+)$/)
    return m?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * Candidates best first. Decline beats a slipping position, which beats
 * "close to page one"; the caller still checks each post's age.
 */
export function pickRefreshes(opts: {
  trends: PageTrend[]
  striking: (GscRow & { opportunity: number })[]
  /** Slugs that are engine content files in the repo. */
  contentSlugs: Set<string>
  /** Titles by slug, for the plan and the reviewer. */
  titles: Map<string, string>
}): RefreshCandidate[] {
  const queriesFor = (slug: string) =>
    opts.striking
      .filter((r) => r.page && r.query && blogSlug(r.page) === slug)
      .sort((a, b) => b.impressions - a.impressions)
      .map((r) => r.query!)
      .filter((q, i, all) => all.indexOf(q) === i)
      .slice(0, 6)

  const out = new Map<string, Scored>()
  const offer = (c: Scored) => {
    const prev = out.get(c.slug)
    if (!prev || c.score > prev.score) out.set(c.slug, c)
  }

  for (const t of opts.trends) {
    const slug = blogSlug(t.page)
    if (!slug || !opts.contentSlugs.has(slug)) continue
    const base = { slug, title: opts.titles.get(slug) ?? slug, url: t.page, queries: queriesFor(slug) }
    if (t.priorClicks >= 5 && t.clicks <= t.priorClicks * 0.7) {
      offer({ ...base, score: 3 + (t.priorClicks - t.clicks) / t.priorClicks, reason: `clicks fell from ${t.priorClicks} to ${t.clicks} (last 28 days vs the 28 before)` })
    }
    if (t.priorImpressions >= 100 && t.position > 0 && t.priorPosition > 0 && t.position - t.priorPosition >= 3) {
      offer({
        ...base,
        score: 2 + (t.position - t.priorPosition) / 10,
        reason: `average Google position slipped from ${t.priorPosition.toFixed(1)} to ${t.position.toFixed(1)}`,
      })
    }
  }

  for (const r of opts.striking) {
    if (!r.page || !r.query) continue
    const slug = blogSlug(r.page)
    if (!slug || !opts.contentSlugs.has(slug) || r.position > 15.5) continue
    offer({
      slug,
      title: opts.titles.get(slug) ?? slug,
      url: r.page,
      queries: queriesFor(slug),
      score: 1 + Math.min(1, r.opportunity / 1000),
      reason: `shows at position ${r.position.toFixed(1)} for “${r.query}” (${r.impressions} impressions) — close to page one`,
    })
  }

  return [...out.values()].sort((a, b) => b.score - a.score).map(({ score: _s, ...c }) => {
    void _s
    return c
  })
}

/** Days since a post's `updated` (or `date`) — Infinity when it can't be read. */
export function daysSinceUpdated(post: { updated?: unknown; date?: unknown }, now: Date): number {
  const raw = typeof post.updated === 'string' && post.updated ? post.updated : typeof post.date === 'string' ? post.date : ''
  const t = Date.parse(raw)
  return Number.isNaN(t) ? Infinity : Math.floor((now.getTime() - t) / 86_400_000)
}
