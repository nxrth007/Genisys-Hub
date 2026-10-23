import { prisma } from '@/lib/prisma'
import { fetchPage } from '@/lib/seo/crawl'
import { readFile } from '@/lib/seo/github'
import { bareHost, jsonLdNodes } from '@/lib/seo/html'
import { squashName } from '@/lib/site-match'

/**
 * Live sites that could be this client's, for the Site field's dropdown.
 *
 * Lovable won't say where a project is published: neither its API nor its
 * sign-in returns the project's domain. So the Hub tries the addresses a
 * client's site usually lives at (the business name as .org / .com, the
 * repo name, <name>.lovable.app, which Lovable redirects to the custom
 * domain once one is connected, and anything the client or the site's
 * code names), opens each one, and keeps the ones that answer. A site is
 * "confirmed" when the page itself names the business or shows its phone
 * number, so a domain someone else owns never shows up as the right one.
 */

export type SiteSuggestion = {
  /** Where the address ends up after redirects, e.g. https://luxamaservices.org */
  url: string
  title: string | null
  /** The page names this business or shows its phone number. */
  confirmed: boolean
  /** Served by Lovable (our builds). */
  lovable: boolean
  /** What led here: "business name", "repo name", "onboarding form", … */
  from: string[]
  /** Another client already has this as their site. */
  takenBy: string | null
  /** It's the client's Site already. */
  current: boolean
}

const HOST_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/
const FREE_MAIL = /^(gmail|yahoo|myyahoo|hotmail|outlook|icloud|aol|live|msn|me|comcast|protonmail|proton|att|ymail|mail)\./
const MAX_CANDIDATES = 18

/** "https://www.Luxama.org/x" / "Luxama.org" / "info@luxama.org" → "luxama.org". */
function hostIn(v: string | null | undefined): string | null {
  const s = (v ?? '').trim().toLowerCase()
  if (!s || /\s/.test(s)) return null
  const host = (s.includes('@') ? s.split('@')[1] : s.replace(/^[a-z]+:\/\//, '').split(/[/?#:]/)[0]).replace(/^www\./, '')
  if (!HOST_RE.test(host) || host === 'share.google' || FREE_MAIL.test(host)) return null
  return host
}

/** The business name as a domain label, with and without the LLC: "Jake's Property Maintenance LLC" → jakespropertymaintenancellc, jakespropertymaintenance. */
function nameLabels(name: string): string[] {
  const raw = name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '')
  const bare = raw.replace(/(llc|inc|corp|co)$/, '')
  return [...new Set([bare, raw])].filter((l) => l.length >= 4 && l.length <= 63)
}

const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '').slice(-10)

export async function siteSuggestions(clientId: string): Promise<SiteSuggestion[]> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      name: true,
      siteUrl: true,
      website: true,
      contactEmail: true,
      contactPhone: true,
      seoSite: { select: { liveUrl: true, repoFullName: true, archivedAt: true } },
      intakes: {
        orderBy: { receivedAt: 'desc' },
        take: 1,
        select: { businessName: true, domainName: true, website: true, leadEmail: true, customerPhone: true, businessContact: true },
      },
    },
  })
  if (!client) return []
  const intake = client.intakes[0]
  const repo = client.seoSite && !client.seoSite.archivedAt ? client.seoSite.repoFullName : null
  // The domain the site's code is built for (src/lib/seo.ts). A remixed build can still name another client's
  // domain; that one shows up as taken.
  const lib = repo ? await readFile(repo, 'src/lib/seo.ts', 'main').catch(() => null) : null
  const others = await prisma.client.findMany({
    where: { id: { not: clientId }, archivedAt: null, siteUrl: { not: null } },
    select: { name: true, siteUrl: true },
  })
  return findSites({
    names: [client.name, intake?.businessName ?? null],
    siteUrl: client.siteUrl,
    seoLiveUrl: client.seoSite?.liveUrl ?? null,
    given: [intake?.domainName, intake?.website, client.website].filter((v): v is string => !!v),
    emails: [client.contactEmail, intake?.leadEmail].filter((v): v is string => !!v),
    phones: [client.contactPhone, intake?.customerPhone, intake?.businessContact].filter((v): v is string => !!v),
    repo,
    codeSiteUrl: lib?.match(/export\s+const\s+SITE_URL\s*(?::\s*string\s*)?=\s*["'`]([^"'`]+)["'`]/)?.[1] ?? null,
    otherSites: others.map((o) => ({ name: o.name, siteUrl: o.siteUrl })),
  })
}

export type SiteSearch = {
  /** The client's name and the business name from the form. */
  names: (string | null)[]
  siteUrl: string | null
  seoLiveUrl: string | null
  /** Domains or websites the client gave us. */
  given: string[]
  emails: string[]
  phones: string[]
  repo: string | null
  /** SITE_URL in the repo's src/lib/seo.ts. */
  codeSiteUrl: string | null
  otherSites: { name: string; siteUrl: string | null }[]
}

/** Try the likely addresses and keep the live ones (no database; the caller gathers the facts). */
export async function findSites(o: SiteSearch): Promise<SiteSuggestion[]> {
  const repo = o.repo
  const candidates = new Map<string, Set<string>>()
  const add = (host: string | null, why: string) => {
    if (!host || !HOST_RE.test(host)) return
    if (!candidates.has(host)) candidates.set(host, new Set())
    candidates.get(host)!.add(why)
  }
  // What the client or the Hub already names.
  add(hostIn(o.seoLiveUrl), 'SEO site')
  for (const g of o.given) add(hostIn(g), 'onboarding form')
  for (const e of o.emails) add(hostIn(e), 'business email')
  add(hostIn(o.codeSiteUrl), 'the site’s code')
  // Where we usually put a client's site.
  for (const name of o.names) {
    for (const l of nameLabels(name ?? '')) {
      add(`${l}.org`, 'business name')
      add(`${l}.com`, 'business name')
      add(`${l}.lovable.app`, 'business name')
    }
  }
  if (repo) {
    const l = (repo.split('/').pop() ?? '').toLowerCase().replace(/client$/, '')
    if (/^[a-z0-9-]{4,63}$/.test(l)) {
      add(`${l}.lovable.app`, 'repo name')
      add(`${l}.org`, 'repo name')
    }
  }

  const takenBy = new Map<string, string>()
  for (const other of o.otherSites) {
    const h = hostIn(other.siteUrl)
    if (h) takenBy.set(h, other.name)
  }

  const names = o.names.map(squashName).filter((n) => n.length >= 4)
  const phones = o.phones.map(digits).filter((d) => d.length === 10)
  const currentHost = hostIn(o.siteUrl)

  const pages = await Promise.all(
    [...candidates.entries()].slice(0, MAX_CANDIDATES).map(async ([host, from]) => {
      const page = await fetchPage(`https://${host}/`, { timeoutMs: 6_000 }).catch(() => null)
      if (!page || page.error || page.status < 200 || page.status >= 300) return null
      return { page, from: [...from] }
    }),
  )

  const out = new Map<string, SiteSuggestion & { named: boolean }>()
  for (const hit of pages) {
    if (!hit) continue
    const { page } = hit
    let final: URL
    try {
      final = new URL(page.url)
    } catch {
      continue
    }
    const host = bareHost(final.hostname)
    const texts = [
      page.title,
      page.social['og:site_name'],
      page.social['og:title'],
      ...jsonLdNodes(page.jsonLd.blocks).map((n) => (typeof n.name === 'string' ? n.name : null)),
    ]
      .map((t) => squashName(t))
      .filter(Boolean)
    const named = names.some((n) => texts.some((t) => t.includes(n) || (t.length >= 6 && n.includes(t))))
    const phoned = phones.some((p) => page.telLinks.some((t) => digits(t) === p) || page.textSample.replace(/\D/g, '').includes(p))
    const prev = out.get(host)
    // A .lovable.app address that redirected here and the domain itself are one site.
    const lovable = page.hosting === 'lovable' || !!prev?.lovable
    const mentions = named || phoned || !!prev?.named
    out.set(host, {
      url: final.origin,
      title: page.title,
      // Our build naming the business. Another company with the same name ("Esparza Solutions LLC", a
      // bookkeeper in Florida) has a site too; it isn't on Lovable, so it isn't confirmed.
      confirmed: lovable && mentions,
      named: mentions,
      lovable,
      from: [...new Set([...(prev?.from ?? []), ...hit.from])],
      takenBy: takenBy.get(host) ?? null,
      current: host === currentHost,
    })
  }

  const rank = (s: SiteSuggestion) => (s.takenBy ? 0 : 4) + (s.confirmed ? 2 : 0) + (s.lovable ? 1 : 0)
  return (
    [...out.values()]
      // A guessed address that answers with someone else's page (roofdoc.com → a roofer in Pennsylvania) is noise;
      // an address the client gave us is worth showing even when it's their old site.
      .filter((s) => s.named || (!s.takenBy && s.from.some((f) => f === 'onboarding form' || f === 'business email' || f === 'SEO site')))
      // Best first; a bare .lovable.app address (no custom domain behind it) after a real domain.
      .sort((a, b) => rank(b) - rank(a) || Number(a.url.includes('.lovable.app')) - Number(b.url.includes('.lovable.app')))
  )
}
