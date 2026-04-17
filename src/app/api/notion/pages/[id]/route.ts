import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { getPage, getPageContent, archivePage } from '@/lib/notion'

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  try {
    const [page, content] = await Promise.all([getPage(id), getPageContent(id)])
    return NextResponse.json({ page, blocks: (content as { results?: unknown[] }).results || [] })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}

/**
 * DELETE /api/notion/pages/[id]
 * Archives the page in Notion (Notion's equivalent of delete from an
 * integration — the page moves to Trash and can be restored or permanently
 * deleted from the Notion UI).
 */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  try {
    await archivePage(id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
