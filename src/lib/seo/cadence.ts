/**
 * How many new posts a site's weekly run may write.
 *
 * A new site needs a base of posts quickly, but a local contractor only has
 * so many real questions customers search for. Past that, more posts are
 * padding, and Google demotes sites that mass-publish pages written to rank.
 * So the engine ramps, then tapers:
 *
 *   - Ramp: the dashboard's posts-per-week (6 by default) until the site has
 *     its ramp target — the dashboard's number (12), raised to 3 per service
 *     for sites with more services, up to 15.
 *   - Steady: a couple a week after that, and only for searches the site
 *     already shows up for without a page that answers them (Search
 *     Console), or a clear seasonal or local need from the research.
 *
 * A number set on the site's own page, or a one-off for its next run, wins
 * over both. Pure — no database — so the pipeline and the site page agree.
 */

export type CadencePhase = 'ramp' | 'steady' | 'site' | 'one_off'

export type Cadence = {
  phase: CadencePhase
  /** New posts this run may write. */
  postsAllowed: number
  /** Posts the site has: on the site at the last run, plus the engine's since. */
  have: number
  /** Where the ramp ends for this site. */
  target: number
  /** One line for the run log and the site page. */
  summary: string
}

/** The ramp target never goes above this on its own (a larger dashboard number still wins). */
export const RAMP_SERVICE_CAP = 15
export const POSTS_PER_SERVICE = 3

export function rampTarget(base: number, serviceCount: number): number {
  return Math.max(base, Math.min(POSTS_PER_SERVICE * serviceCount, RAMP_SERVICE_CAP))
}

/** Distinct posts: the site's existing ones plus the engine's committed or live ones not yet in that list. */
export function postCount(siteSlugs: string[], ledger: Array<{ slug: string; status: string }>): number {
  const slugs = new Set(siteSlugs)
  for (const p of ledger) if (p.status === 'committed' || p.status === 'live') slugs.add(p.slug)
  return slugs.size
}

const plural = (n: number) => `${n} post${n === 1 ? '' : 's'}`

export function postCadence(o: {
  postsNextRun: number | null
  sitePostsPerWeek: number | null
  rampPostsPerWeek: number
  rampTargetPosts: number
  steadyPostsPerWeek: number
  have: number
  serviceCount: number
}): Cadence {
  const target = rampTarget(o.rampTargetPosts, o.serviceCount)
  const base = { have: o.have, target }
  if (o.postsNextRun != null) {
    return { ...base, phase: 'one_off', postsAllowed: o.postsNextRun, summary: `One-off for this run: up to ${plural(o.postsNextRun)}.` }
  }
  if (o.sitePostsPerWeek != null) {
    return { ...base, phase: 'site', postsAllowed: o.sitePostsPerWeek, summary: `This site's own setting: up to ${plural(o.sitePostsPerWeek)} a week.` }
  }
  const left = target - o.have
  if (left > 0) {
    // Don't overshoot the target by much: the last ramp week writes what's left, never less than the steady pace.
    const postsAllowed = Math.max(Math.min(o.rampPostsPerWeek, left), Math.min(o.steadyPostsPerWeek, o.rampPostsPerWeek))
    return {
      ...base,
      phase: 'ramp',
      postsAllowed,
      summary: `Building the base: ${o.have} of ${target} posts, so up to ${plural(postsAllowed)} this week.`,
    }
  }
  return {
    ...base,
    phase: 'steady',
    postsAllowed: o.steadyPostsPerWeek,
    summary: `Base built (${o.have} posts, target ${target}): up to ${plural(o.steadyPostsPerWeek)} a week, only where searches show a gap.`,
  }
}
