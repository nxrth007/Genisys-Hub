import { prisma } from '@/lib/prisma'
import { readProfile } from './accounts'
import { imageKind, stripJpegMetadata } from './image-bytes'
import { mediaUrl, saveMedia } from './media'
import { fetchTwilioMedia, publicBase } from './twilio'

/**
 * Recent Work: photos the owner texts to their business number, shown on their website.
 *
 * Each photo is kept in Media Storage (HlMedia, served at /hl/media/…) with an HlRecord of kind
 * work_photo beside it (caption, who sent it, shown). The website shows them through the feed
 * script (/hl/work.js, reading /api/hl/public/work/<account>), so a new photo is on the site the
 * moment it's saved: no commit, no Lovable publish. The Hub's own page /hl/w/<account> shows the
 * same feed. Deleting the image in Media Storage takes it off both.
 *
 * Every photo is re-encoded before it's kept: resized to web size and, above all, stripped of its
 * metadata, since a phone photo carries the GPS position of the job (a customer's home).
 */

export const WORK_PHOTO_KIND = 'work_photo'
/** Photos per feed. */
export const WORK_PHOTOS_SHOWN = 60
/** Photos taken from one text. */
export const WORK_PHOTOS_PER_TEXT = 6
/** Longest side after resizing. */
const MAX_SIDE = 1600
const MAX_BYTES = 5 * 1024 * 1024

export type WorkPhoto = { id: string; url: string; caption: string; at: string }
export type Added = { added: number; /** Not a photo. */ skipped: number; /** A photo that couldn't be fetched or made safe. */ failed: number }

/** Who sent a photo in: "owner-text:+1603…" on the media row. */
export const OWNER_TEXT_BY = (phone: string) => `owner-text:${phone}`

/**
 * Web size, no metadata: re-encoded by sharp (Next's own image library) when it can; else a JPEG's
 * metadata segments dropped and the picture left as it is. Anything that can't be made safe that way
 * (sharp refused it and it isn't a JPEG that can be walked) is refused: `null`.
 */
export async function webPhoto(bytes: Uint8Array): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const kind = imageKind(bytes)
  if (!kind) return null
  try {
    const sharp = (await import('sharp')).default
    const out = await sharp(Buffer.from(bytes)).rotate().resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toBuffer()
    return { bytes: new Uint8Array(out), mime: 'image/jpeg' }
  } catch (err) {
    console.warn('[genisys-os] photo: sharp couldn’t take it; falling back to a metadata strip:', err instanceof Error ? err.message : err)
  }
  const stripped = kind === 'jpeg' ? stripJpegMetadata(bytes) : null
  return stripped ? { bytes: stripped, mime: 'image/jpeg' } : null
}

/** The photos in an owner's text, kept. Each is fetched from Twilio with the Hub's credentials. */
export async function addWorkPhotos(o: { accountId: string; from: string; mediaUrls: string[]; caption: string }): Promise<Added> {
  let added = 0
  let skipped = 0
  let failed = 0
  for (const url of o.mediaUrls.slice(0, WORK_PHOTOS_PER_TEXT)) {
    const got = await fetchTwilioMedia(url, MAX_BYTES).catch((err) => {
      console.warn('[genisys-os] photo: fetch failed:', err instanceof Error ? err.message : err)
      return null
    })
    if (!got) {
      failed++
      continue
    }
    if (!/^image\//i.test(got.contentType) || !imageKind(got.bytes)) {
      skipped++
      continue
    }
    const photo = await webPhoto(got.bytes)
    if (!photo) {
      failed++
      continue
    }
    const day = new Date().toISOString().slice(0, 10)
    const media = await saveMedia({ accountId: o.accountId, bytes: photo.bytes, name: `job-photo-${day}`, by: OWNER_TEXT_BY(o.from) })
    await prisma.hlRecord.create({
      data: { accountId: o.accountId, kind: WORK_PHOTO_KIND, name: o.caption.slice(0, 140), data: { mediaId: media.id, caption: o.caption, from: o.from, at: new Date().toISOString(), shown: true } },
    })
    added++
  }
  return { added, skipped, failed }
}

/** The feed, newest first: only photos still in Media Storage. */
export async function listWorkPhotos(accountId: string): Promise<WorkPhoto[]> {
  const rows = await prisma.hlRecord.findMany({ where: { accountId, kind: WORK_PHOTO_KIND }, orderBy: { createdAt: 'desc' }, take: WORK_PHOTOS_SHOWN * 2, select: { id: true, data: true, createdAt: true } })
  const items = rows
    .map((r) => {
      const d = (r.data ?? {}) as { mediaId?: unknown; caption?: unknown; at?: unknown; shown?: unknown }
      return typeof d.mediaId === 'string' && d.shown !== false ? { id: r.id, mediaId: d.mediaId, caption: typeof d.caption === 'string' ? d.caption : '', at: typeof d.at === 'string' ? d.at : r.createdAt.toISOString() } : null
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
  if (!items.length) return []
  const media = new Map((await prisma.hlMedia.findMany({ where: { id: { in: items.map((i) => i.mediaId) }, accountId }, select: { id: true, mimeType: true } })).map((m) => [m.id, m]))
  return items
    .flatMap((i) => {
      const m = media.get(i.mediaId)
      return m ? [{ id: i.id, url: mediaUrl(m), caption: i.caption, at: i.at }] : []
    })
    .slice(0, WORK_PHOTOS_SHOWN)
}

export type WorkFeed = { business: string; color: string; logo: string | null; website: string | null; page: string; photos: WorkPhoto[] }

export const workPageUrl = (accountId: string) => `${publicBase()}/hl/w/${accountId}`

/** What the website's feed script and the Hub's own page show. Null for no such (live) sub-account. */
export async function workFeed(accountId: string): Promise<WorkFeed | null> {
  const account = await prisma.hlAccount.findUnique({ where: { id: accountId }, select: { name: true, profile: true, archivedAt: true } })
  if (!account || account.archivedAt) return null
  const p = readProfile(account.profile)
  return {
    business: p.businessName || account.name,
    color: /^#[0-9a-f]{6}$/i.test(p.brandColor ?? '') ? p.brandColor! : '#155EEF',
    logo: /^https?:\/\//i.test(p.logoUrl ?? '') ? p.logoUrl! : null,
    website: /^https?:\/\//i.test(p.website?.trim() ?? '') ? p.website!.trim() : null,
    page: workPageUrl(accountId),
    photos: await listWorkPhotos(accountId),
  }
}

const EMBED_KEY = (accountId: string) => `hl.workEmbed.${accountId}`
/** A site that asked for the feed this recently shows it. */
const EMBED_FRESH_MS = 7 * 86_400_000
/** When each sub-account's site was last noted (this process); looked at again hourly, so page views cost nothing. */
const noted = new Map<string, number>()

const hostOf = (url: string | null | undefined): string => {
  try {
    return url ? new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, '') : ''
  } catch {
    return ''
  }
}

/**
 * The feed was asked for from a web page (the request's origin or referer). When that page is the
 * client's own site, the site shows the feed. Any other caller (a person's browser, a copy of the
 * link elsewhere) says nothing.
 */
export async function noteWorkEmbedSeen(accountId: string, host: string): Promise<void> {
  const h = host.toLowerCase().replace(/^www\./, '')
  if (!h || h === hostOf(publicBase())) return
  if (Date.now() - (noted.get(accountId) ?? 0) < 3_600_000) return
  if (noted.size > 1000) noted.clear()
  noted.set(accountId, Date.now())
  const account = await prisma.hlAccount.findUnique({ where: { id: accountId }, select: { profile: true, client: { select: { siteUrl: true } } } })
  const own = [account?.client?.siteUrl, readProfile(account?.profile).website].map(hostOf).filter(Boolean)
  if (!own.some((site) => h === site || h.endsWith(`.${site}`))) return
  const value = JSON.stringify({ at: new Date().toISOString(), host: h })
  await prisma.appSetting.upsert({ where: { key: EMBED_KEY(accountId) }, create: { key: EMBED_KEY(accountId), value }, update: { value } }).catch(() => undefined)
}

/** Does the client's website show the feed? True when a site asked for it in the last week. */
export async function siteShowsWork(accountId: string): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key: EMBED_KEY(accountId) } }).catch(() => null)
  try {
    const v = row ? (JSON.parse(row.value) as { at?: string }) : null
    return !!v?.at && Date.now() - Date.parse(v.at) < EMBED_FRESH_MS
  } catch {
    return false
  }
}
