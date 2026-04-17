import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { listUsers } from '@/lib/notion'

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  try {
    const data = await listUsers()
    const results = (data.results || []) as Array<{
      id: string
      name?: string
      person?: { email?: string }
      type?: string
    }>
    const users = results
      .filter((u) => u.type === 'person')
      .map((u) => ({
        id: u.id,
        name: u.name || '',
        email: u.person?.email || '',
      }))
    return NextResponse.json({ users })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
