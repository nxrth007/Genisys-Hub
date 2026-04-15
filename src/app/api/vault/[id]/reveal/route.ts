import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { revealEntry } from '@/lib/vault-service'

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { id } = await ctx.params

  try {
    const result = await revealEntry(id, session.user.id)
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 404 })
  }
}
