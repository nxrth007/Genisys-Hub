import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET    /api/documents/[id]  → stream the file bytes with the right
 *                                Content-Type + Content-Disposition so
 *                                browsers either render inline (PDF) or
 *                                download (DOCX/XLSX).
 * DELETE /api/documents/[id]  → remove the document.
 * PATCH  /api/documents/[id]  → rename or move (filename / folderId).
 */

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return new Response('unauthorized', { status: 401 })
  }

  const { id } = await ctx.params
  const doc = await prisma.document.findUnique({
    where: { id },
    select: {
      filename: true,
      mimeType: true,
      content: true,
      sizeBytes: true,
    },
  })
  if (!doc) {
    return new Response('not found', { status: 404 })
  }

  // RFC 5987 encoded filename for non-ASCII safety
  const safeName = encodeURIComponent(doc.filename)
  // PDFs + images can render inline; everything else downloads. Saves a
  // click for the common "let me peek at this contract" case.
  const canInline =
    doc.mimeType === 'application/pdf' || doc.mimeType.startsWith('image/')
  const disposition = canInline ? 'inline' : 'attachment'

  return new Response(doc.content as unknown as BodyInit, {
    headers: {
      'Content-Type': doc.mimeType || 'application/octet-stream',
      'Content-Length': String(doc.sizeBytes),
      'Content-Disposition': `${disposition}; filename*=UTF-8''${safeName}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=0',
    },
  })
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { id } = await ctx.params
  const exists = await prisma.document.findUnique({ where: { id } })
  if (!exists) return NextResponse.json({ error: 'not found' }, { status: 404 })

  await prisma.document.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { id } = await ctx.params
  const body = (await req.json().catch(() => ({}))) as {
    filename?: string
    folderId?: string | null
  }
  const data: Record<string, unknown> = {}
  if (typeof body.filename === 'string' && body.filename.trim().length > 0) {
    data.filename = body.filename.trim()
  }
  if (body.folderId === null) {
    data.folderId = null
  } else if (typeof body.folderId === 'string' && body.folderId.length > 0) {
    const folder = await prisma.documentFolder.findUnique({
      where: { id: body.folderId },
    })
    if (!folder) {
      return NextResponse.json({ error: 'destination folder not found' }, { status: 404 })
    }
    data.folderId = body.folderId
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
  }

  const updated = await prisma.document.update({
    where: { id },
    data,
    select: {
      id: true,
      filename: true,
      folderId: true,
    },
  })
  return NextResponse.json({ ok: true, document: updated })
}
