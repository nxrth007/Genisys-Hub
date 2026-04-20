import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * POST /api/documents/folders
 * Body: { name: string, parentId?: string | null }
 * Creates a new folder. Caller decides whether it's root-level (parentId
 * omitted or null) or nested inside another folder.
 */
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    name?: string
    parentId?: string | null
  }
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) {
    return NextResponse.json({ error: 'name required' }, { status: 400 })
  }

  const parentId = body.parentId ?? null
  if (parentId) {
    const parent = await prisma.documentFolder.findUnique({ where: { id: parentId } })
    if (!parent) {
      return NextResponse.json({ error: 'parent folder not found' }, { status: 404 })
    }
  }

  const folder = await prisma.documentFolder.create({
    data: {
      name,
      parentId,
      createdById: session.user.id,
    },
  })

  return NextResponse.json({ ok: true, folder })
}
