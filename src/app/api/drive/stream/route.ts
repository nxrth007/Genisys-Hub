import { NextRequest } from 'next/server'
import { Readable } from 'stream'
import { auth } from '@/auth'
import { getAuthenticatedClient } from '@/lib/drive'

/**
 * GET /api/drive/stream?id=<fileId>&account=<email>
 *
 * Streams a Drive file's bytes through our backend using the stored OAuth
 * token for the given account. Lets the in-Hub preview render files that
 * Chrome's cookie session can't access (e.g. when you're not currently
 * signed into the owning Workspace account in this browser profile).
 *
 * Google Workspace documents (Docs, Sheets, Slides, Drawings) aren't raw
 * files — they must be exported to a renderable format. We pick PDF so the
 * browser's built-in viewer handles it inline.
 *
 * Binary files (PDFs, images, video, etc.) are passed through as-is.
 */

const EXPORT_MIME: Record<string, string> = {
  'application/vnd.google-apps.document': 'application/pdf',
  'application/vnd.google-apps.spreadsheet': 'application/pdf',
  'application/vnd.google-apps.presentation': 'application/pdf',
  'application/vnd.google-apps.drawing': 'application/pdf',
}

// Google-native types that can't be downloaded as bytes and have no export
// format suitable for an <iframe>. Falls back to drive.google.com.
const NOT_STREAMABLE = new Set([
  'application/vnd.google-apps.folder',
  'application/vnd.google-apps.shortcut',
  'application/vnd.google-apps.form',
  'application/vnd.google-apps.site',
  'application/vnd.google-apps.map',
])

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return new Response('unauthorized', { status: 401 })
  }

  const fileId = req.nextUrl.searchParams.get('id')
  const accountEmail = req.nextUrl.searchParams.get('account')
  if (!fileId || !accountEmail) {
    return new Response('missing id or account', { status: 400 })
  }

  try {
    const { drive } = await getAuthenticatedClient(accountEmail)

    // Need the mimeType to decide between export and direct download, and
    // the name for the Content-Disposition so save-as picks a sane filename.
    const meta = await drive.files.get({
      fileId,
      fields: 'id, name, mimeType',
      supportsAllDrives: true,
    })

    const mime = meta.data.mimeType || 'application/octet-stream'
    const name = meta.data.name || 'file'

    if (NOT_STREAMABLE.has(mime)) {
      return new Response(
        JSON.stringify({ error: `Files of type ${mime} can't be streamed inline` }),
        { status: 415, headers: { 'content-type': 'application/json' } }
      )
    }

    let nodeStream: Readable
    let contentType: string

    if (EXPORT_MIME[mime]) {
      const res = await drive.files.export(
        { fileId, mimeType: EXPORT_MIME[mime] },
        { responseType: 'stream' }
      )
      nodeStream = res.data as unknown as Readable
      contentType = EXPORT_MIME[mime]
    } else {
      const res = await drive.files.get(
        { fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream' }
      )
      nodeStream = res.data as unknown as Readable
      contentType = mime
    }

    // Convert Node Readable → Web ReadableStream for the Next response body.
    const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>

    // filename* uses RFC 5987 encoding so non-ASCII names survive.
    const safeName = encodeURIComponent(name)

    return new Response(webStream, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `inline; filename*=UTF-8''${safeName}`,
        // Prevent Chrome from MIME-sniffing and reclassifying our response as
        // a download — a common cause of "This page has been blocked by Chrome"
        // when the iframe loads. Paired with a correct, explicit Content-Type.
        'X-Content-Type-Options': 'nosniff',
        // Explicit same-origin frame-ancestors — allows embedding from our own
        // pages and nothing else.
        'Content-Security-Policy': "frame-ancestors 'self'",
        // Short private cache — lets quick re-opens skip the Drive round-trip
        // but doesn't stale on edits.
        'Cache-Control': 'private, max-age=60',
      },
    })
  } catch (err) {
    console.error('[drive/stream] failed:', err)
    const message = err instanceof Error ? err.message : 'Failed to stream file'
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }
}
