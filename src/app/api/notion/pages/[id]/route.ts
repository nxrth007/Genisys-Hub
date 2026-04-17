import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { getPage, getPageContent } from '@/lib/notion'

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
