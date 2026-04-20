import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/documents/search?q=<term>
 *
 * Case-insensitive substring match across every folder name + document
 * filename in the Hub. Returns a flat list of results tagged with type
 * + their full path (ancestor folder names) so the UI can render
 * "Contracts / Legal / NDA.pdf" context for each hit.
 *
 * Walks the folder tree once up front, then derives paths in-memory
 * rather than round-tripping per-result.
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const q = req.nextUrl.searchParams.get('q')?.trim() || ''
  if (!q) {
    return NextResponse.json({ results: [] })
  }

  const [allFolders, matchingFolders, matchingDocs] = await Promise.all([
    // Pull all folders so we can build path strings cheaply client-side
    // here without per-result queries. Tens/hundreds is fine; if we ever
    // grow past thousands we'll want a recursive CTE instead.
    prisma.documentFolder.findMany({
      select: { id: true, name: true, parentId: true },
    }),
    prisma.documentFolder.findMany({
      where: { name: { contains: q, mode: 'insensitive' } },
      select: {
        id: true,
        name: true,
        parentId: true,
        updatedAt: true,
        _count: { select: { documents: true, children: true } },
        createdBy: { select: { name: true, email: true } },
      },
      orderBy: { name: 'asc' },
      take: 100,
    }),
    prisma.document.findMany({
      where: { filename: { contains: q, mode: 'insensitive' } },
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
      take: 100,
    }),
  ])

  const folderById = new Map(allFolders.map((f) => [f.id, f]))
  function pathFor(parentId: string | null): string[] {
    const crumbs: string[] = []
    let cursor = parentId
    const seen = new Set<string>()
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      const f = folderById.get(cursor)
      if (!f) break
      crumbs.unshift(f.name)
      cursor = f.parentId
    }
    return crumbs
  }

  const results = [
    ...matchingFolders.map((f) => ({
      kind: 'folder' as const,
      id: f.id,
      parentId: f.parentId,
      name: f.name,
      path: pathFor(f.parentId),
      documentCount: f._count.documents,
      childCount: f._count.children,
      updatedAt: f.updatedAt,
      createdBy: f.createdBy,
    })),
    ...matchingDocs.map((d) => ({
      kind: 'document' as const,
      id: d.id,
      folderId: d.folderId,
      filename: d.filename,
      path: pathFor(d.folderId),
      mimeType: d.mimeType,
      sizeBytes: d.sizeBytes,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      uploadedBy: d.uploadedBy,
    })),
  ]

  return NextResponse.json({ results, query: q })
}
