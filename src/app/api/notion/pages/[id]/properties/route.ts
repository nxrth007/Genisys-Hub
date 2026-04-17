import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { updatePage } from '@/lib/notion'

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const body = await req.json().catch(() => null)
  if (!body?.properties) {
    return NextResponse.json({ error: 'properties required' }, { status: 400 })
  }

  try {
    const result = await updatePage(id, body.properties)
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
