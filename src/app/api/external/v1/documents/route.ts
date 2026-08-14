import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { withExternalApi, externalOptions } from '@/lib/external-api'

/**
 * GET /api/external/v1/documents — file metadata only.
 *
 * The `content` Bytes column is never selected: this is a directory
 * listing for display, not a download surface.
 */
export const GET = withExternalApi(async () => {
  const docs = await prisma.document.findMany({
    orderBy: { createdAt: 'desc' },
    take: 60,
    select: {
      id: true,
      filename: true,
      mimeType: true,
      sizeBytes: true,
      createdAt: true,
      folder: { select: { name: true } },
      uploadedBy: { select: { name: true } },
    },
  })

  return docs.map((d) => ({
    id: d.id,
    filename: d.filename,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    folderName: d.folder?.name ?? null,
    uploadedBy: d.uploadedBy?.name ?? null,
    createdAt: d.createdAt,
  }))
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
