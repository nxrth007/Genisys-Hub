import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import {
  ALLOWED_MIME_TYPES,
  MAX_FILE_BYTES,
  resolveMimeType,
} from '@/lib/documents'

/**
 * GET /api/documents?folderId=<id?>
 *   Lists the folders + documents directly under the given parent.
 *   Omit folderId to list the root. Also returns the folder's ancestry
 *   so the UI can render a breadcrumb.
 *
 * POST /api/documents
 *   Upload a single file as multipart/form-data. Fields:
 *     file      (required) — the file
 *     folderId  (optional) — parent folder; null = root
 *   Rejects disallowed MIME types and anything over MAX_FILE_BYTES.
 */

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const folderId = req.nextUrl.searchParams.get('folderId') || null

  const [folders, documents, folder] = await Promise.all([
    prisma.documentFolder.findMany({
      where: { parentId: folderId },
      orderBy: { name: 'asc' },
      include: {
        createdBy: { select: { name: true, email: true } },
        _count: { select: { documents: true, children: true } },
      },
    }),
    prisma.document.findMany({
      where: { folderId },
      // Exclude `content` so listing payloads stay small — download endpoint
      // serves the bytes separately.
      select: {
        id: true,
        folderId: true,
        filename: true,
        mimeType: true,
        sizeBytes: true,
        createdAt: true,
        updatedAt: true,
        uploadedBy: { select: { name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    folderId
      ? prisma.documentFolder.findUnique({
          where: { id: folderId },
          select: { id: true, name: true, parentId: true },
        })
      : null,
  ])

  // Build the breadcrumb by walking up the parent chain (bounded to avoid
  // a runaway loop if the DB has a cycle somehow).
  const crumbs: Array<{ id: string; name: string }> = []
  let current = folder
  const seen = new Set<string>()
  while (current && !seen.has(current.id) && crumbs.length < 20) {
    seen.add(current.id)
    crumbs.unshift({ id: current.id, name: current.name })
    if (!current.parentId) break
    current = await prisma.documentFolder.findUnique({
      where: { id: current.parentId },
      select: { id: true, name: true, parentId: true },
    })
  }

  return NextResponse.json({ folders, documents, crumbs })
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const form = await req.formData().catch(() => null)
  if (!form) {
    return NextResponse.json({ error: 'multipart/form-data required' }, { status: 400 })
  }

  const file = form.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file field required' }, { status: 400 })
  }

  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      { error: `File too large — max ${MAX_FILE_BYTES / 1024 / 1024} MB` },
      { status: 413 }
    )
  }

  const mimeType = resolveMimeType(file.name, file.type)
  if (!ALLOWED_MIME_TYPES[mimeType]) {
    return NextResponse.json(
      {
        error: `File type not allowed (${mimeType || 'unknown'}). Allowed: ${Object.values(
          ALLOWED_MIME_TYPES
        )
          .map((v) => v.ext)
          .join(', ')}`,
      },
      { status: 415 }
    )
  }

  const folderIdRaw = form.get('folderId')
  const folderId = typeof folderIdRaw === 'string' && folderIdRaw ? folderIdRaw : null

  // Validate folder belongs to nothing weird if provided
  if (folderId) {
    const exists = await prisma.documentFolder.findUnique({ where: { id: folderId } })
    if (!exists) {
      return NextResponse.json({ error: 'folder not found' }, { status: 404 })
    }
  }

  const buffer = Buffer.from(await file.arrayBuffer())

  const doc = await prisma.document.create({
    data: {
      folderId,
      filename: file.name,
      mimeType,
      sizeBytes: buffer.length,
      content: buffer,
      uploadedById: session.user.id,
    },
    select: {
      id: true,
      filename: true,
      mimeType: true,
      sizeBytes: true,
      folderId: true,
      createdAt: true,
    },
  })

  return NextResponse.json({ ok: true, document: doc })
}
