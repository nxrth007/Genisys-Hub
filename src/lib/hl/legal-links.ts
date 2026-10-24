import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { getTree, readFile } from '@/lib/seo/github'
import { readProfile } from './accounts'
import { publicBase } from './twilio'
import type { HlFormSettings, HlProfile } from './types'

/**
 * Where a form's "Privacy Policy" and "Terms" links go. In order: the form's
 * own links, the sub-account's (Business Profile), then the pages the Hub
 * hosts for every sub-account. Genisys-built sites have their own
 * SMS-ready /privacy and /terms pages, so a client with a live site and a
 * connected repo gets those filled into the profile (fillLegalLinksFromSite).
 */

export type LegalLinks = { privacy: string; terms: string }

const httpUrl = (v: string | null | undefined): string | null => {
  const s = v?.trim()
  return s && /^https?:\/\/[^\s/$.?#][^\s]*$/i.test(s) ? s : null
}

export const hostedLegalUrl = (accountId: string, doc: 'privacy' | 'terms') => `${publicBase()}/hl/legal/${accountId}/${doc}`

/** A page on the Hub itself (its own domain, or Render's): never what a client's registration should point reviewers at. */
export function isHubUrl(url: string): boolean {
  try {
    const host = new URL(url).host.toLowerCase()
    return host === new URL(publicBase()).host.toLowerCase() || host.endsWith('.onrender.com')
  } catch {
    return false
  }
}

export function resolveLegalLinks(accountId: string, profile: HlProfile, settings?: HlFormSettings): LegalLinks {
  return {
    privacy: httpUrl(settings?.privacyUrl) ?? httpUrl(profile.privacyUrl) ?? hostedLegalUrl(accountId, 'privacy'),
    terms: httpUrl(settings?.termsUrl) ?? httpUrl(profile.termsUrl) ?? hostedLegalUrl(accountId, 'terms'),
  }
}

/** A route file's URL path: TanStack's src/routes/privacy.tsx → /privacy, legal.terms.tsx or legal/terms.tsx → /legal/terms. Null for layouts and dynamic routes. */
function routePath(file: string): string | null {
  const m = file.match(/^src\/routes\/(.+)\.(?:t|j)sx?$/)
  if (!m) return null
  const path = `/${m[1].replace(/(^|\/)index$/, '').replace(/\./g, '/').replace(/\/route$/, '')}`.replace(/\/$/, '') || '/'
  return /[$_()[\]]/.test(path) ? null : path
}

/**
 * The client's live site (Clients: the site we built) and the pages its repo
 * has (file routes, or the paths in src/App.tsx on older single-page sites).
 * Null without a live site; no pages without a connected repo.
 */
async function siteRoutes(clientId: string): Promise<{ origin: string; paths: Set<string> } | null> {
  const [site, client] = await Promise.all([
    prisma.seoSite.findUnique({ where: { clientId }, select: { liveUrl: true, repoFullName: true, defaultBranch: true } }),
    prisma.client.findUnique({ where: { id: clientId }, select: { siteUrl: true } }),
  ])
  const base = httpUrl(site?.liveUrl) ?? httpUrl(client?.siteUrl)
  if (!base) return null
  const origin = new URL(base).origin
  const paths = new Set<string>()
  if (!site?.repoFullName) return { origin, paths }
  const ref = site.defaultBranch || 'main'
  const { entries } = await getTree(site.repoFullName, ref)
  for (const e of entries) {
    const p = e.type === 'blob' ? routePath(e.path) : null
    if (p) paths.add(p)
  }
  if (![...paths].some((p) => /privac|terms/i.test(p))) {
    const app = await readFile(site.repoFullName, 'src/App.tsx', ref).catch(() => null)
    for (const m of app?.matchAll(/path=["'`](\/[^"'`]*)["'`]/g) ?? []) paths.add(m[1])
  }
  return { origin, paths }
}

/**
 * The client's website's own privacy and terms pages, read from its repo.
 * Null when there's no live site with a connected repo, or no such pages.
 */
export async function detectSiteLegalLinks(clientId: string): Promise<{ privacyUrl: string | null; termsUrl: string | null; site: string } | null> {
  const found = await siteRoutes(clientId)
  if (!found?.paths.size) return null
  const { origin, paths } = found
  const shortest = (re: RegExp) => [...paths].filter((p) => re.test(p)).sort((a, b) => a.length - b.length)[0] ?? null
  const privacy = shortest(/privac/i)
  const terms = shortest(/terms|conditions/i)
  if (!privacy && !terms) return null
  return { privacyUrl: privacy ? `${origin}${privacy}` : null, termsUrl: terms ? `${origin}${terms}` : null, site: origin }
}

/**
 * Where people ask for a quote on the client's own site: the home page, and
 * its contact or quote page when it has one. Empty without a live site.
 */
export async function siteFormPages(clientId: string): Promise<string[]> {
  const found = await siteRoutes(clientId).catch(() => null)
  if (!found) return []
  const extra = ['/contact', '/contact-us', '/quote', '/get-a-quote', '/free-estimate', '/estimate'].filter((p) => found.paths.has(p))
  return [`${found.origin}/`, ...extra.map((p) => `${found.origin}${p}`)]
}

const lastLook = new Map<string, number>()

/**
 * Fill the sub-account's blank privacy/terms links from its website. At most
 * hourly per sub-account unless forced; never throws (the Hub's own pages
 * stay the fallback).
 */
export async function fillLegalLinksFromSite(accountId: string, force = false): Promise<{ privacyUrl: string | null; termsUrl: string | null } | null> {
  if (!force && Date.now() - (lastLook.get(accountId) ?? 0) < 3600_000) return null
  lastLook.set(accountId, Date.now())
  try {
    const account = await prisma.hlAccount.findUnique({ where: { id: accountId }, select: { clientId: true, profile: true } })
    if (!account?.clientId) return null
    const p = readProfile(account.profile)
    if (!force && httpUrl(p.privacyUrl) && httpUrl(p.termsUrl)) return null
    const found = await detectSiteLegalLinks(account.clientId)
    if (!found) return null
    const next: HlProfile = {
      ...p,
      privacyUrl: (force ? found.privacyUrl : httpUrl(p.privacyUrl) ?? found.privacyUrl) ?? p.privacyUrl ?? '',
      termsUrl: (force ? found.termsUrl : httpUrl(p.termsUrl) ?? found.termsUrl) ?? p.termsUrl ?? '',
    }
    await prisma.hlAccount.update({ where: { id: accountId }, data: { profile: next as Prisma.InputJsonValue } })
    return { privacyUrl: next.privacyUrl || null, termsUrl: next.termsUrl || null }
  } catch (err) {
    console.warn(`[hell-level] legal links for ${accountId}:`, err instanceof Error ? err.message : err)
    return null
  }
}
