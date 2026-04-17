import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { createFile, listFilesAll, type ListOptions } from '@/lib/drive'

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

/**
 * POST /api/drive/files
 * Body: { account, kind: 'document'|'spreadsheet'|'presentation'|'folder', name, parentId? }
 *
 * Creates a blank file in Drive and returns its metadata. The kind selects
 * which Google Workspace mimeType to create.
 */
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    account?: string
    kind?: 'document' | 'spreadsheet' | 'presentation' | 'folder'
    name?: string
    parentId?: string
  }

  if (!body.account || !body.kind || !body.name) {
    return NextResponse.json(
      { error: 'account, kind and name are required' },
      { status: 400 }
    )
  }

  try {
    const file = await createFile(body.account, {
      kind: body.kind,
      name: body.name,
      parentId: body.parentId,
    })
    return NextResponse.json({ ok: true, file })
  } catch (err) {
    console.error('[drive/files POST] failed:', err)
    const googleMsg =
      (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
        ?.message
    const message = googleMsg || (err instanceof Error ? err.message : 'Create failed')
    return NextResponse.json(
      { error: message },
      { status: message.includes('insufficient') ? 403 : 500 }
    )
  }
}
