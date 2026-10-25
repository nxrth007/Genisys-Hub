import { mediaFile } from '@/lib/hl/media'

type Ctx = { params: Promise<{ file: string }> }

/**
 * GET /hl/media/<id>.<ext>: a sub-account's image (src/lib/hl/media.ts), for
 * anyone: forms and the chat bubble show logos from here on client websites.
 * An id's bytes never change, so it caches for good; the headers keep it an
 * image and nothing else.
 */
export async function GET(_req: Request, { params }: Ctx) {
  const { file } = await params
  const m = await mediaFile(file.replace(/\.[a-z0-9]+$/i, ''))
  if (!m) return new Response('Not found', { status: 404 })
  return new Response(new Uint8Array(m.content), {
    headers: {
      'content-type': m.mimeType,
      'content-length': String(m.sizeBytes),
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'cross-origin',
      'access-control-allow-origin': '*',
    },
  })
}
