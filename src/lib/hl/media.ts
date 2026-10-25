import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { readProfile } from './accounts'
import { HlInputError } from './http'
import { publicBase } from './twilio'

/**
 * Images a sub-account keeps itself (Media Storage, beside what came over
 * from GoHighLevel): a logo uploaded here, or copied in from a link that won't
 * last. Peakfinity Studio's links expire after a week, and so do ChatGPT's.
 * They're kept in the database and served publicly at /hl/media/<id>.<ext>,
 * so forms and the chat bubble on client websites can show them.
 *
 * Raster images only, checked by their bytes: never SVG, which can carry
 * script and would be served from the Hub's own address.
 */

export const MAX_MEDIA_BYTES = 5 * 1024 * 1024

export const PEAKFINITY_STUDIO_URL = 'https://peakfinity-studio.onrender.com/studio'

const KINDS: { mime: string; ext: string; is: (b: Uint8Array) => boolean }[] = [
  { mime: 'image/png', ext: 'png', is: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', ext: 'jpg', is: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', ext: 'webp', is: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP' },
  { mime: 'image/gif', ext: 'gif', is: (b) => ascii(b, 0, 4) === 'GIF8' },
]

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.slice(from, to))
const extOf = (mime: string) => KINDS.find((k) => k.mime === mime)?.ext ?? 'png'

export type MediaItem = { id: string; name: string; mimeType: string; sizeBytes: number; sourceUrl: string | null; createdBy: string | null; createdAt: Date; url: string }

/** Where the image is served, for anyone (a client's website included). */
export const mediaUrl = (m: { id: string; mimeType: string }) => `${publicBase()}/hl/media/${m.id}.${extOf(m.mimeType)}`

const isMediaUrl = (url: string) => url.startsWith(`${publicBase()}/hl/media/`)

const item = (m: Omit<MediaItem, 'url'>): MediaItem => ({ id: m.id, name: m.name, mimeType: m.mimeType, sizeBytes: m.sizeBytes, sourceUrl: m.sourceUrl, createdBy: m.createdBy, createdAt: m.createdAt, url: mediaUrl(m) })

/** A file name worth keeping: the given one, tidied, with the extension the bytes call for. */
function fileName(raw: string | null | undefined, ext: string): string {
  const base = (raw ?? '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${base || 'logo'}.${ext}`
}

export async function saveMedia(o: { accountId: string; bytes: Uint8Array; name?: string | null; sourceUrl?: string | null; by: string }): Promise<MediaItem> {
  if (!o.bytes.length) throw new HlInputError('That file is empty.')
  if (o.bytes.length > MAX_MEDIA_BYTES) throw new HlInputError('That image is over 5 MB. A logo needs far less: export a smaller one.')
  const kind = KINDS.find((k) => k.is(o.bytes))
  if (!kind) throw new HlInputError('That isn’t a PNG, JPEG, WebP or GIF image. (SVG isn’t taken: export a PNG instead.)')
  const row = await prisma.hlMedia.create({
    data: { accountId: o.accountId, name: fileName(o.name, kind.ext), mimeType: kind.mime, sizeBytes: o.bytes.length, content: new Uint8Array(o.bytes), sourceUrl: o.sourceUrl ?? null, createdBy: o.by },
    select: { id: true, name: true, mimeType: true, sizeBytes: true, sourceUrl: true, createdBy: true, createdAt: true },
  })
  return item(row)
}

/** Local and private addresses aren't images anyone means to fetch. */
function privateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h === '::1') return true
  const v4 = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/)
  if (!v4) return /^(fc|fd|fe80)/.test(h) && h.includes(':')
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** The body, but no more than `max` bytes of it. */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const reader = res.body?.getReader()
  if (!reader) return new Uint8Array(await res.arrayBuffer())
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > max) {
      await reader.cancel()
      throw new HlInputError('That image is over 5 MB. A logo needs far less: export a smaller one.')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

/** Copy the image at a link into the sub-account's media. */
export async function copyMediaFromUrl(o: { accountId: string; url: string; by: string }): Promise<MediaItem> {
  let u: URL
  try {
    u = new URL(o.url.trim())
  } catch {
    throw new HlInputError('That isn’t a link.')
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || privateHost(u.hostname)) throw new HlInputError('That isn’t a link to an image on the web.')
  const res = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(20_000), headers: { accept: 'image/*', 'user-agent': 'Mozilla/5.0 (compatible; GenisysHub/1.0; +https://genisys-hub.onrender.com)' } }).catch(() => null)
  if (!res?.ok) throw new HlInputError(`Couldn’t download the image at that link${res ? ` (${res.status})` : ''}. If it came from Peakfinity Studio or ChatGPT it may have expired: download it there and upload the file instead.`)
  const bytes = await readCapped(res, MAX_MEDIA_BYTES)
  const last = decodeURIComponent(u.pathname.split('/').pop() ?? '')
  return saveMedia({ accountId: o.accountId, bytes, name: last, sourceUrl: u.toString(), by: o.by })
}

/**
 * A logo link as the profile should keep it: links on the client's own
 * website stay as they are; anything else (Peakfinity Studio, ChatGPT, a
 * file host) is copied here first, since those links expire or move.
 */
export async function keepLogo(o: { accountId: string; url: string; website: string | null | undefined; by: string }): Promise<string> {
  const url = o.url.trim()
  if (!/^https?:\/\//i.test(url) || isMediaUrl(url)) return url
  const host = (s: string) => {
    try {
      return new URL(/^https?:/i.test(s) ? s : `https://${s}`).hostname.toLowerCase().replace(/^www\./, '')
    } catch {
      return ''
    }
  }
  const site = host(o.website ?? '')
  const from = host(url)
  if (site && (from === site || from.endsWith(`.${site}`))) return url
  return (await copyMediaFromUrl({ accountId: o.accountId, url, by: o.by })).url
}

export async function listMedia(accountId: string): Promise<MediaItem[]> {
  const rows = await prisma.hlMedia.findMany({
    where: { accountId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, mimeType: true, sizeBytes: true, sourceUrl: true, createdBy: true, createdAt: true },
  })
  return rows.map(item)
}

/** For the public route: the bytes and their type. */
export async function mediaFile(id: string) {
  return prisma.hlMedia.findUnique({ where: { id }, select: { mimeType: true, sizeBytes: true, content: true } })
}

async function ownMedia(accountId: string, mediaId: string) {
  const row = await prisma.hlMedia.findFirst({ where: { id: mediaId, accountId }, select: { id: true, name: true, mimeType: true, sizeBytes: true, sourceUrl: true, createdBy: true, createdAt: true } })
  if (!row) throw new HlInputError('That image isn’t in this sub-account’s media.')
  return row
}

/** Make an image the sub-account's logo (Business Profile → Logo): forms and the chat bubble show it. */
export async function setLogo(accountId: string, mediaId: string): Promise<string> {
  const row = await ownMedia(accountId, mediaId)
  const account = await prisma.hlAccount.findUniqueOrThrow({ where: { id: accountId }, select: { profile: true } })
  const url = mediaUrl(row)
  await prisma.hlAccount.update({ where: { id: accountId }, data: { profile: { ...readProfile(account.profile), logoUrl: url } as Prisma.InputJsonValue } })
  return url
}

export async function deleteMedia(accountId: string, mediaId: string): Promise<void> {
  const row = await ownMedia(accountId, mediaId)
  const account = await prisma.hlAccount.findUniqueOrThrow({ where: { id: accountId }, select: { profile: true } })
  if (readProfile(account.profile).logoUrl === mediaUrl(row)) throw new HlInputError('That’s the sub-account’s logo. Set a different logo first (Settings → Business Profile).')
  await prisma.hlMedia.delete({ where: { id: row.id } })
}

const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n).replace(/[\s,;]+\S*$/, '')}…` : t
}

/**
 * A prompt for Peakfinity Studio (GPT Image 2 or Nano Banana 2) that makes a
 * logo from the client's onboarding answers: the business name spelled out,
 * what they do and where, and their colours.
 */
export async function logoPrompt(accountId: string): Promise<string> {
  const account = await prisma.hlAccount.findUniqueOrThrow({ where: { id: accountId }, select: { name: true, profile: true, clientId: true } })
  const p = readProfile(account.profile)
  const intake = account.clientId
    ? await prisma.clientIntake.findFirst({ where: { clientId: account.clientId }, orderBy: { receivedAt: 'desc' }, select: { mainServices: true, brandColors: true, cities: true } })
    : null
  const name = (p.businessName ?? '').trim() || account.name
  const services = clip(intake?.mainServices, 200)
  const city = clip(intake?.cities, 60)
  const colours = clip(intake?.brandColors, 120) || (p.brandColor ?? '')
  return [
    `Design a logo for "${name}"${services ? `, a local business offering ${services}` : ''}${city ? `, serving ${city}` : ''}.`,
    'Clean, modern and professional: one simple, bold icon that hints at what the business does, beside the business name in a strong, very legible sans-serif.',
    `Spell the name exactly "${name}". No tagline and no other words.`,
    colours ? `Colours: ${colours}.` : 'Colours: two strong colours that suit the trade, plus black or white.',
    'Flat vector style: no gradients, 3D, photos, mockups or shadows. It must read at small sizes, like a website header or a chat bubble.',
    'Centred on a plain white background with even space around it. Square.',
  ].join('\n')
}
