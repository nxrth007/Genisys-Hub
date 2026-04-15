import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { getAuditLog } from '@/lib/vault-service'

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { id } = await ctx.params
  const log = await getAuditLog(id)
  return NextResponse.json({ log })
}
