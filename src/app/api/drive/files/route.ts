import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { listFilesAll, type ListOptions } from '@/lib/drive'

/**
 * GET /api/drive/files
 * Query params:
 *   q          — free-text search
 *   kind       — all | folders | docs | sheets | slides | pdf | images
 *   ownership  — any | mine | shared | starred
 *   parentId   — list children of a folder
 *   account    — limit to a single connected mailbox
 *   pageSize   — files per account (default 50, capped at 200)
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const sp = req.nextUrl.searchParams
  const pageSizeRaw = Number(sp.get('pageSize') ?? 50)
  const opts: ListOptions = {
    query: sp.get('q') || undefined,
    kind: sp.get('kind') || undefined,
    ownership: sp.get('ownership') || undefined,
    parentId: sp.get('parentId') || undefined,
    accountEmail: sp.get('account') || undefined,
    pageSize: Math.min(
      200,
      Math.max(1, Number.isFinite(pageSizeRaw) ? pageSizeRaw : 50)
    ),
  }

  try {
    const result = await listFilesAll(opts)
    return NextResponse.json(result)
  } catch (err) {
    console.error('[drive/files] list failed:', err)
    const message = err instanceof Error ? err.message : 'Failed to list files'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
