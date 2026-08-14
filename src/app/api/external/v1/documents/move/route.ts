import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { externalWrite, WriteError } from '@/lib/external-write'
import { externalOptions } from '@/lib/external-api'

/**
 * PATCH /api/external/v1/documents/move
 * body: { id, folderId | null, filename? }
 *
 * Moves a file between folders, or renames it. folderId null means the
 * root, which is a real destination rather than a missing value.
 */
export const PATCH = externalWrite(async ({ body }) => {
  const id = String(body.id ?? '').trim()
  if (!id) throw new WriteError('id is required.')

  const doc = await prisma.document.findUnique({ where: { id } })
  if (!doc) throw new WriteError('File not found.', 404)

  const data: Record<string, unknown> = {}

  if ('folderId' in body) {
    const raw = body.folderId
    const folderId = typeof raw === 'string' && raw.trim() ? raw.trim() : null
    if (folderId) {
      const folder = await prisma.documentFolder.findUnique({
        where: { id: folderId },
      })
      if (!folder) throw new WriteError('That folder no longer exists.', 404)
    }
    data.folderId = folderId
  }

  if (typeof body.filename === 'string' && body.filename.trim()) {
    data.filename = body.filename.trim()
  }

  if (Object.keys(data).length === 0) throw new WriteError('Nothing to change.')

  await prisma.document.update({ where: { id }, data })
  return { id, ...data }
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
