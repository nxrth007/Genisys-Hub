import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { withExternalApi, externalOptions } from '@/lib/external-api'
import { externalWrite, WriteError } from '@/lib/external-write'

/**
 * GET    folders with their document counts
 * POST   create a folder
 * DELETE remove one — only when empty
 */
export const GET = withExternalApi(async (_req, auth) => {
  if (!auth.user) throw new Error('This requires a signed-in account.')

  const folders = await prisma.documentFolder.findMany({
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      parentId: true,
      createdAt: true,
      _count: { select: { documents: true } },
    },
  })

  return {
    folders: folders.map((f) => ({
      id: f.id,
      name: f.name,
      parentId: f.parentId,
      documentCount: f._count.documents,
      createdAt: f.createdAt,
    })),
  }
})

export const POST = externalWrite(async ({ auth, body }) => {
  const name = String(body.name ?? '').trim()
  if (!name) throw new WriteError('Give the folder a name.')
  if (name.length > 120) throw new WriteError('That name is too long.')

  const existing = await prisma.documentFolder.findFirst({
    where: { name, parentId: null },
  })
  if (existing) throw new WriteError(`"${name}" already exists.`)

  const folder = await prisma.documentFolder.create({
    data: { name, createdById: auth.user.id },
    select: { id: true, name: true },
  })
  return folder
})

export const DELETE = externalWrite(async (_ctx, req) => {
  const id = req.nextUrl.searchParams.get('id') ?? ''
  if (!id) throw new WriteError('id is required.')

  const folder = await prisma.documentFolder.findUnique({
    where: { id },
    select: { id: true, name: true, _count: { select: { documents: true } } },
  })
  if (!folder) throw new WriteError('Folder not found.', 404)

  // DocumentFolder cascades to its children, and documents would be
  // orphaned or deleted depending on the relation — refusing a non-empty
  // folder keeps a misclick from taking files with it.
  if (folder._count.documents > 0) {
    throw new WriteError(
      `"${folder.name}" still has ${folder._count.documents} file${
        folder._count.documents === 1 ? '' : 's'
      }. Move or delete them first.`,
    )
  }

  await prisma.documentFolder.delete({ where: { id } })
  return { id }
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
