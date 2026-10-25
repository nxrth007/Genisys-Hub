import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { readProfile } from './accounts'
import { isBrandish, parseCssColor } from './color'
import type { HlProfile } from './types'

/**
 * A sub-account's logo and brand colour (Business Profile → Logo, Brand
 * colour). Forms show the logo at the top, as GHL's form builder does with an
 * image block, and forms and the chat widget take the colour. A client's are
 * found on the website we built them:
 *   - the logo: the page's first image whose alt text or file name says "logo"
 *     (their header), else the site's touch icon;
 *   - the colour: the template's accent (--accent-gold, whatever its hue),
 *     else a colourful --accent / --primary, else the theme-color meta.
 * Both can be set by hand too.
 */

const UA = 'Mozilla/5.0 (compatible; GenisysHub/1.0; +https://genisys-hub.onrender.com)'
const httpUrl = (v: string | null | undefined) => (v && /^https?:\/\/\S+$/i.test(v.trim()) ? v.trim() : null)

const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return m ? (m[2] ?? m[3] ?? m[4] ?? '').trim() : ''
}

export type SiteBrand = { logo: string | null; color: string | null }

/** The logo and brand colour on a website's home page (absolute address, hex), each null when not found. */
export async function findSiteBrand(site: string): Promise<SiteBrand> {
  const start = httpUrl(site) ?? (site.trim() ? `https://${site.trim().replace(/^\/+/, '')}` : null)
  if (!start) return { logo: null, color: null }
  const res = await fetch(start, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(12_000) })
  if (!res.ok) return { logo: null, color: null }
  const page = res.url || start
  const html = (await res.text()).slice(0, 600_000)
  const abs = (src: string) => {
    try {
      return src && !src.startsWith('data:') ? new URL(src.replace(/&amp;/g, '&'), page).toString() : null
    } catch {
      return null
    }
  }
  const [logo, color] = await Promise.all([logoOf(html, abs), colorOf(html, abs)])
  return { logo, color }
}

async function logoOf(html: string, abs: (src: string) => string | null): Promise<string | null> {
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

async function colorOf(html: string, abs: (src: string) => string | null): Promise<string | null> {
  const sheets = [...html.matchAll(/<link\b[^>]*>/gi)]
    .map((m) => m[0])
    .filter((t) => /rel\s*=\s*["']?stylesheet/i.test(t) || /\.css(\?|["'\s>])/i.test(attr(t, 'href')))
    .map((t) => abs(attr(t, 'href')))
    .filter((u): u is string => !!u)
    .slice(0, 3)
  const inline = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n')
  const css = [inline]
  for (const u of sheets) {
    try {
      const r = await fetch(u, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10_000) })
      if (r.ok) css.push((await r.text()).slice(0, 3_000_000))
    } catch {
      // the next sheet, or the meta tag
    }
  }
  const all = css.join('\n')
  const values = (name: string) => [...all.matchAll(new RegExp(`--${name}\\s*:\\s*([^;}]+)`, 'gi'))].map((m) => parseCssColor(m[1])).filter((c): c is string => !!c)
  // The template's accent first, then the last colourful accent or primary (a site's own override follows the stock theme's).
  const picked = values('accent-gold').find(isBrandish) ?? values('accent').reverse().find(isBrandish) ?? values('primary').reverse().find(isBrandish) ?? values('brand').reverse().find(isBrandish)
  if (picked) return picked
  const meta = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]).find((t) => /name\s*=\s*["']?theme-color/i.test(t))
  const themed = meta ? parseCssColor(attr(meta, 'content')) : null
  return themed && isBrandish(themed) ? themed : null
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

/**
 * Find the logo and brand colour on the sub-account's website and keep them
 * on the profile. Ones already there stay, unless `force`. Returns what the
 * profile has afterwards.
 */
export async function fillBrandFromSite(accountId: string, force = false): Promise<SiteBrand> {
  const account = await prisma.hlAccount.findUnique({ where: { id: accountId }, select: { profile: true, client: { select: { siteUrl: true } } } })
  if (!account) return { logo: null, color: null }
  const p = readProfile(account.profile)
  const had = { logo: httpUrl(p.logoUrl), color: parseCssColor(p.brandColor ?? '') }
  if (!force && had.logo && had.color) return had
  const site = httpUrl(p.website) ?? httpUrl(account.client?.siteUrl) ?? p.website ?? account.client?.siteUrl ?? ''
  if (!site.trim()) return had
  const found = await findSiteBrand(site).catch((err) => {
    console.warn(`[hell-level] brand for ${accountId}:`, err instanceof Error ? err.message : err)
    return { logo: null, color: null }
  })
  const logo = (force ? found.logo : had.logo) ?? had.logo ?? found.logo
  const color = (force ? found.color : had.color) ?? had.color ?? found.color
  if (logo === had.logo && color === had.color) return had
  const fresh = readProfile((await prisma.hlAccount.findUniqueOrThrow({ where: { id: accountId }, select: { profile: true } })).profile)
  const next: HlProfile = { ...fresh, ...(logo ? { logoUrl: logo } : {}), ...(color ? { brandColor: color } : {}) }
  await prisma.hlAccount.update({ where: { id: accountId }, data: { profile: next as Prisma.InputJsonValue } })
  return { logo, color }
}

/**
 * Twice a day: a sub-account with a website (its own, or its client's live
 * site) and no logo or brand colour gets its site's. Catches clients who
 * onboarded before their site was built, and sites that were down.
 */
let lastSweep = 0
export async function maybeFillLogos(): Promise<number> {
  if (Date.now() - lastSweep < 12 * 3600_000) return 0
  lastSweep = Date.now()
  const accounts = await prisma.hlAccount.findMany({ where: { archivedAt: null }, select: { id: true, profile: true, client: { select: { siteUrl: true } } } })
  let filled = 0
  for (const a of accounts) {
    const p = readProfile(a.profile)
    if ((httpUrl(p.logoUrl) && parseCssColor(p.brandColor ?? '')) || !(p.website?.trim() || a.client?.siteUrl)) continue
    const before = `${p.logoUrl}|${p.brandColor}`
    const after = await fillBrandFromSite(a.id)
    if (`${after.logo ?? p.logoUrl}|${after.color ?? p.brandColor}` !== before) filled++
  }
  return filled
}
