import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { searchNotion } from '@/lib/notion'

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const q = req.nextUrl.searchParams.get('q') || ''
  const type = req.nextUrl.searchParams.get('type')

  try {
    const filter = type && type !== 'all'
      ? { property: 'object', value: type }
      : undefined
    const data = await searchNotion(q, filter)
    return NextResponse.json(data)
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
