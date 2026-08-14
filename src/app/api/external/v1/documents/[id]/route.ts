import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { verifyExternalRequest } from '@/lib/external-api'
import { corsPreflight, withCors } from '@/lib/external-cors'

/**
 * GET    /api/external/v1/documents/:id   download the file
 * DELETE /api/external/v1/documents/:id   remove it
 *
 * Download streams the stored bytes with Content-Disposition, so the
 * browser saves it under its real name instead of the route id.
 */
export async function GET(req: NextRequest) {
  const origin = req.headers.get('origin')
  const auth = await verifyExternalRequest(req)
  if (!auth?.user) {
    return withCors(
      NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
      origin,
    )
  }

  const id = req.nextUrl.pathname.split('/').pop() ?? ''
  const doc = await prisma.document.findUnique({ where: { id } })
  if (!doc) {
    return withCors(
      NextResponse.json({ error: 'Not found' }, { status: 404 }),
      origin,
    )
  }

  const res = new NextResponse(new Uint8Array(doc.content), {
    headers: {
      'Content-Type': doc.mimeType,
      'Content-Length': String(doc.sizeBytes),
      // Quoted so filenames with spaces survive.
      'Content-Disposition': `attachment; filename="${doc.filename.replace(/"/g, '')}"`,
    },
  })
  return withCors(res, origin)
}

export async function DELETE(req: NextRequest) {
  const origin = req.headers.get('origin')
  const auth = await verifyExternalRequest(req)
  if (!auth?.user) {
    return withCors(
      NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
      origin,
    )
  }

  const id = req.nextUrl.pathname.split('/').pop() ?? ''
  const doc = await prisma.document.findUnique({
    where: { id },
    select: { id: true, filename: true },
  })
  if (!doc) {
    return withCors(
      NextResponse.json({ error: 'Not found' }, { status: 404 }),
      origin,
    )
  }

  await prisma.document.delete({ where: { id } })
  console.log(`[documents] ${auth.user.email} deleted ${doc.filename}`)

  return withCors(NextResponse.json({ ok: true, data: { id } }), origin)
}

export const OPTIONS = (req: NextRequest) => corsPreflight(req)
