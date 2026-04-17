import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { getFolderAncestry } from '@/lib/drive'

/**
 * GET /api/drive/folder?id=<folderId>&account=<email>
 * Returns the folder's breadcrumb ancestry as an ordered array of
 * { id, name } from the root down to the target folder (inclusive).
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const id = req.nextUrl.searchParams.get('id')
  const account = req.nextUrl.searchParams.get('account')
  if (!id || !account) {
    return NextResponse.json({ error: 'id and account required' }, { status: 400 })
  }

  try {
    const crumbs = await getFolderAncestry(account, id)
    return NextResponse.json({ crumbs })
  } catch (err) {
    console.error('[drive/folder] failed:', err)
    const message = err instanceof Error ? err.message : 'Failed to resolve folder'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
