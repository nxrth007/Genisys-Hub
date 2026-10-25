import { NextResponse } from 'next/server'
import { hlAccountOr404, hlError, hlGuard, HlInputError, jsonBody, str } from '@/lib/hl/http'
import { copyMediaFromUrl, deleteMedia, listMedia, logoPrompt, MAX_MEDIA_BYTES, PEAKFINITY_STUDIO_URL, saveMedia, setLogo } from '@/lib/hl/media'

type Ctx = { params: Promise<{ id: string }> }

/**
 * GET: the sub-account's own media (src/lib/hl/media.ts).
 * GET ?prompt=1: also the Peakfinity Studio logo prompt from the client's onboarding answers.
 */
export async function GET(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  try {
    const wantPrompt = new URL(req.url).searchParams.get('prompt') === '1'
    const [media, prompt] = await Promise.all([listMedia(id), wantPrompt ? logoPrompt(id) : null])
    return NextResponse.json({ media, ...(wantPrompt ? { prompt, studioUrl: PEAKFINITY_STUDIO_URL } : {}) })
  } catch (err) {
    return hlError(err, 'load media')
  }
}

/**
 * POST multipart { file }: upload an image.
 * POST { url }: copy the image at a link (Peakfinity Studio's and ChatGPT's expire).
 * POST { action: 'set-logo', mediaId }: make it the Business Profile logo.
 */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  try {
    if ((req.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
      const form = await req.formData()
      const file = form.get('file')
      if (!(file instanceof File)) throw new HlInputError('Choose an image to upload.')
      if (file.size > MAX_MEDIA_BYTES) throw new HlInputError('That image is over 5 MB. A logo needs far less: export a smaller one.')
      const media = await saveMedia({ accountId: id, bytes: new Uint8Array(await file.arrayBuffer()), name: file.name, by: guard.email })
      return NextResponse.json({ media })
    }
    const body = await jsonBody(req)
    if (body.action === 'set-logo') {
      const mediaId = str(body.mediaId)
      if (!mediaId) throw new HlInputError('Which image?')
      return NextResponse.json({ logoUrl: await setLogo(id, mediaId) })
    }
    const url = str(body.url)
    if (!url) throw new HlInputError('Paste a link to the image, or upload the file.')
    return NextResponse.json({ media: await copyMediaFromUrl({ accountId: id, url, by: guard.email }) })
  } catch (err) {
    return hlError(err, 'save media')
  }
}

/** DELETE ?mediaId=: remove an image (not the one that's the logo). */
export async function DELETE(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  try {
    const mediaId = new URL(req.url).searchParams.get('mediaId')
    if (!mediaId) throw new HlInputError('Which image?')
    await deleteMedia(id, mediaId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return hlError(err, 'delete media')
  }
}
