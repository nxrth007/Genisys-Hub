import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { readProfile } from './accounts'
import type { HlProfile } from './types'

/**
 * A sub-account's logo (Business Profile → Logo). Forms show it at the top,
 * as GHL's form builder does with an image block. A client's is found on the
 * website we built them: the page's first image whose alt text or file name
 * says "logo" (their header), else the site's touch icon. It can be pasted
 * by hand too.
 */

const UA = 'Mozilla/5.0 (compatible; GenisysHub/1.0; +https://genisys-hub.onrender.com)'
const httpUrl = (v: string | null | undefined) => (v && /^https?:\/\/\S+$/i.test(v.trim()) ? v.trim() : null)

const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return m ? (m[2] ?? m[3] ?? m[4] ?? '').trim() : ''
}

/** The logo on a website's home page, as an absolute address, or null. */
export async function findSiteLogo(site: string): Promise<string | null> {
  const start = httpUrl(site) ?? (site.trim() ? `https://${site.trim().replace(/^\/+/, '')}` : null)
  if (!start) return null
  const res = await fetch(start, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(12_000) })
  if (!res.ok) return null
  const page = res.url || start
  const html = (await res.text()).slice(0, 600_000)
  const abs = (src: string) => {
    try {
      return src && !src.startsWith('data:') ? new URL(src.replace(/&amp;/g, '&'), page).toString() : null
    } catch {
      return null
    }
  }
  const candidates: string[] = []
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0]
    const src = attr(tag, 'src') || attr(tag, 'data-src')
    if (/logo/i.test(attr(tag, 'alt')) || /logo/i.test(src) || /logo/i.test(attr(tag, 'class'))) {
      const u = abs(src)
      if (u) candidates.push(u)
    }
  }
  // No image says logo: the touch icon is the site's mark at a usable size.
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    if (/rel\s*=\s*["']?apple-touch-icon/i.test(m[0])) {
      const u = abs(attr(m[0], 'href'))
      if (u) candidates.push(u)
    }
  }
  for (const u of candidates) if (await isImage(u)) return u
  return null
}

async function isImage(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(10_000) })
    const type = r.headers.get('content-type') ?? ''
    await r.body?.cancel().catch(() => undefined)
    return r.ok && /^image\//i.test(type)
  } catch {
    return false
  }
}

/** Find the logo on the sub-account's website and keep it on the profile (a logo already there stays, unless `force`). */
export async function fillLogoFromSite(accountId: string, force = false): Promise<string | null> {
  const account = await prisma.hlAccount.findUnique({ where: { id: accountId }, select: { profile: true, client: { select: { siteUrl: true } } } })
  if (!account) return null
  const p = readProfile(account.profile)
  if (!force && httpUrl(p.logoUrl)) return p.logoUrl!
  const site = httpUrl(p.website) ?? httpUrl(account.client?.siteUrl) ?? p.website ?? account.client?.siteUrl ?? ''
  if (!site.trim()) return null
  const logo = await findSiteLogo(site).catch((err) => {
    console.warn(`[hell-level] logo for ${accountId}:`, err instanceof Error ? err.message : err)
    return null
  })
  if (!logo) return null
  const fresh = readProfile((await prisma.hlAccount.findUniqueOrThrow({ where: { id: accountId }, select: { profile: true } })).profile)
  const next: HlProfile = { ...fresh, logoUrl: logo }
  await prisma.hlAccount.update({ where: { id: accountId }, data: { profile: next as Prisma.InputJsonValue } })
  return logo
}

/**
 * Twice a day: a sub-account with a website (its own, or its client's live
 * site) and no logo gets its site's. Catches clients who onboarded before
 * their site was built, and sites that were down.
 */
let lastSweep = 0
export async function maybeFillLogos(): Promise<number> {
  if (Date.now() - lastSweep < 12 * 3600_000) return 0
  lastSweep = Date.now()
  const accounts = await prisma.hlAccount.findMany({ where: { archivedAt: null }, select: { id: true, profile: true, client: { select: { siteUrl: true } } } })
  let found = 0
  for (const a of accounts) {
    const p = readProfile(a.profile)
    if (httpUrl(p.logoUrl) || !(p.website?.trim() || a.client?.siteUrl)) continue
    if (await fillLogoFromSite(a.id)) found++
  }
  return found
}
