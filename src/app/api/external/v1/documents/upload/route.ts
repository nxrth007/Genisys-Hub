import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  ALLOWED_MIME_TYPES,
  MAX_FILE_BYTES,
  resolveMimeType,
} from '@/lib/documents'
import { verifyExternalRequest } from '@/lib/external-api'
import { corsPreflight, withCors } from '@/lib/external-cors'

/**
 * POST /api/external/v1/documents/upload
 *
 * Multipart upload, mirroring the Hub's own rules — same size cap, same
 * allowed types, same MIME resolution — so a file that uploads in one
 * place uploads in the other.
 *
 * Not routed through externalWrite: that wrapper reads the body as JSON,
 * which would consume the stream and corrupt a multipart payload.
 */
export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin')
  const fail = (message: string, status: number) =>
    withCors(NextResponse.json({ error: message }, { status }), origin)

  const auth = await verifyExternalRequest(req)
  if (!auth) return fail('Missing or invalid API token.', 401)
  if (!auth.user) {
    return fail('Uploading requires a signed-in account.', 403)
  }

  const form = await req.formData().catch(() => null)
  if (!form) return fail('Expected a multipart form upload.', 400)

  const file = form.get('file')
  if (!file || typeof file === 'string') {
    return fail('No file was attached.', 400)
  }

  if (file.size === 0) return fail('That file is empty.', 400)
  if (file.size > MAX_FILE_BYTES) {
    return fail(
      `File too large — max ${MAX_FILE_BYTES / 1024 / 1024} MB.`,
      400,
    )
  }

  // Browsers send an empty or wrong type for some extensions, so the Hub
  // resolves from the filename as well — reuse that rather than trusting
  // file.type alone.
  const mimeType = resolveMimeType(file.name, file.type)
  if (!ALLOWED_MIME_TYPES[mimeType]) {
    return fail(
      `That file type isn't allowed (${mimeType || 'unknown'}).`,
      400,
    )
  }

  const folderIdRaw = form.get('folderId')
  const folderId =
    typeof folderIdRaw === 'string' && folderIdRaw.trim()
      ? folderIdRaw.trim()
      : null

  if (folderId) {
    const folder = await prisma.documentFolder.findUnique({
      where: { id: folderId },
    })
    if (!folder) return fail('That folder no longer exists.', 404)
  }

  const buffer = Buffer.from(await file.arrayBuffer())

  const doc = await prisma.document.create({
    data: {
      filename: file.name,
      mimeType,
      sizeBytes: buffer.length,
      content: buffer,
      folderId,
      uploadedById: auth.user.id,
    },
    select: { id: true, filename: true, sizeBytes: true },
  })

  console.log(
    `[documents] ${auth.user.email} uploaded ${doc.filename} (${doc.sizeBytes} bytes)`,
  )

  return withCors(NextResponse.json({ ok: true, data: doc }), origin)
}

export const OPTIONS = (req: NextRequest) => corsPreflight(req)
