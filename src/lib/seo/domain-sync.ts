import { prisma } from '@/lib/prisma'
import { fetchPage } from './crawl'
import { readFile } from './github'
import { bareHost } from './html'
import { newIndexNowKey } from './indexnow'
import type { ChangeFile, RepoSnapshot } from './types'

/**
 * Keeps a site's code naming the domain it is actually published on.
 *
 * Sites remixed from another build arrive with that build's SITE_URL, or
 * the business's old website, so every canonical link and sitemap entry
 * sends Google to a domain that doesn't serve this site. The Site field on
 * the client (SeoSite.liveUrl) is the truth: when the code disagrees, the
 * weekly run's pull request brings it back in line, and when the client's
 * own domain is connected later and the Site field changes, the next run
 * moves the code over too.
 *
 * Only touches the Genisys template's own files (src/lib/seo.ts,
 * public/robots.txt, src/content/seo.config.json and the IndexNow key
 * file), and only once the Site domain is confirmed to serve this build.
 */

export const SEO_LIB = 'src/lib/seo.ts'
const ROBOTS = 'public/robots.txt'
const SEO_CONFIG = 'src/content/seo.config.json'

const SITE_URL_RE = /(export\s+const\s+SITE_URL\s*(?::\s*string\s*)?=\s*)(["'`])([^"'`]*)\2/
const SITEMAP_LINE_RE = /^Sitemap:[ \t]*(\S*)[ \t]*$/im

export type DomainSync = {
  changes: ChangeFile[]
  /** What changed, for the run log. */
  notes: string[]
  /** Why a needed fix was held back. */
  warnings: string[]
}

function originOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

export async function domainSync(o: {
  siteId: string
  liveUrl: string | null
  indexNowKey: string | null
  repo: RepoSnapshot
}): Promise<DomainSync> {
  const out: DomainSync = { changes: [], notes: [], warnings: [] }
  const origin = originOf(o.liveUrl)
  if (!origin) return out
  const { fullName, defaultBranch } = o.repo
  // Read at the branch head, not the snapshot: the commit lands on top of
  // whatever Lovable pushed since, and must not undo it.
  const read = (path: string) => readFile(fullName, path, defaultBranch).catch(() => null)

  const seoLib = await read(SEO_LIB)
  const m = seoLib ? SITE_URL_RE.exec(seoLib) : null
  if (!seoLib || !m) return out

  const pending: ChangeFile[] = []
  const notes: string[] = []

  const declared = m[3].replace(/\/+$/, '')
  if (declared !== origin) {
    pending.push({
      path: SEO_LIB,
      content: seoLib.replace(SITE_URL_RE, `$1$2${origin}$2`),
      reason: `SITE_URL now names ${origin}, the domain this site is published on (it said ${declared || 'nothing'}). Canonical links, og:url and the sitemap all follow it.`,
      existed: true,
    })
    notes.push(`Canonical links and the sitemap pointed at ${declared || '(no domain)'} — this week's pull request points them at ${origin}, the Site domain in the Hub`)
  }

  const sitemapUrl = `${origin}/sitemap.xml`
  const robots = await read(ROBOTS)
  if (robots != null) {
    const line = SITEMAP_LINE_RE.exec(robots)
    if (!line) {
      pending.push({
        path: ROBOTS,
        content: `${robots.replace(/\s*$/, '')}\n\nSitemap: ${sitemapUrl}\n`,
        reason: `Adds the Sitemap line (${sitemapUrl}) so crawlers find new posts.`,
        existed: true,
      })
    } else if (line[1] !== sitemapUrl) {
      pending.push({
        path: ROBOTS,
        content: robots.replace(SITEMAP_LINE_RE, `Sitemap: ${sitemapUrl}`),
        reason: `The Sitemap line now names ${sitemapUrl} (it said ${line[1] || 'nothing'}).`,
        existed: true,
      })
    }
  }

  const configText = await read(SEO_CONFIG)
  let config: Record<string, unknown> | null = null
  try {
    const v: unknown = configText ? JSON.parse(configText.replace(/^\uFEFF/, '')) : null
    config = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    config = null
  }

  // A remixed repo carries the template's IndexNow key, whose file proves
  // the other site's ownership, not this one's.
  let key = o.indexNowKey
  const keyFile = (k: string) => `public/${k}.txt`
  const needsKeyFile = (k: string) => !o.repo.paths.includes(keyFile(k))
  if (config) {
    const configKey = typeof config.indexNowKey === 'string' ? config.indexNowKey : null
    const configUrl = typeof config.siteUrl === 'string' ? config.siteUrl.replace(/\/+$/, '') : ''
    if (!key || configKey !== key || configUrl !== origin || needsKeyFile(key)) {
      key ??= newIndexNowKey()
      const next = { ...config, siteUrl: origin, indexNowKey: key }
      if (configKey !== key || configUrl !== origin) {
        pending.push({
          path: SEO_CONFIG,
          content: `${JSON.stringify(next, null, 2)}\n`,
          reason: `Records ${origin} and this site's own IndexNow key.`,
          existed: true,
        })
      }
      if (needsKeyFile(key)) {
        pending.push({
          path: keyFile(key),
          content: key,
          reason: 'IndexNow key file, so Bing and other IndexNow engines accept this site’s pings.',
          existed: false,
        })
      }
    }
  }

  if (!pending.length) return out

  // Pointing every canonical at a domain that doesn't serve this build would
  // tell Google to drop the site, so confirm it first — same rule as the foundation.
  const home = await fetchPage(origin, { timeoutMs: 20_000 })
  const wrong =
    home.status !== 200 || home.error
      ? `${origin} doesn\u2019t load (${home.error ?? `HTTP ${home.status}`})`
      : bareHost(new URL(home.url).hostname) !== bareHost(new URL(origin).hostname)
        ? `${origin} redirects to ${originOf(home.url)}`
        : home.hosting && home.hosting !== 'lovable'
          ? `${origin} is served by ${home.hosting}, not this Lovable build`
          : null
  if (wrong) {
    out.warnings.push(`The code's domain needs fixing, but ${wrong}, so it was left alone. Check the Site domain on the client in the Hub.`)
    return out
  }

  if (key && key !== o.indexNowKey) {
    // Saved now so the verify step pings with the key this PR ships; a key
    // another run saved in the meantime wins.
    const res = await prisma.seoSite.updateMany({ where: { id: o.siteId, indexNowKey: null }, data: { indexNowKey: key } })
    if (!res.count) return domainSync({ ...o, indexNowKey: (await prisma.seoSite.findUnique({ where: { id: o.siteId }, select: { indexNowKey: true } }))?.indexNowKey ?? null })
  }

  out.changes = pending
  out.notes = notes
  return out
}
