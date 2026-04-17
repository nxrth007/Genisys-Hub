import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { getDatabase, queryDatabase } from '@/lib/notion'

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const cursor = req.nextUrl.searchParams.get('cursor') || undefined

  try {
    const [schema, data] = await Promise.all([
      getDatabase(id),
      queryDatabase(id, undefined, undefined, cursor),
    ])
    return NextResponse.json({
      schema,
      results: (data as { results?: unknown[] }).results || [],
      hasMore: (data as { has_more?: boolean }).has_more || false,
      nextCursor: (data as { next_cursor?: string | null }).next_cursor || null,
    })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
