import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * PATCH  /api/documents/folders/[id]  → rename or move
 * DELETE /api/documents/folders/[id]  → delete (cascades to children +
 *                                        documents, via schema FK rules)
 */

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { id } = await ctx.params
  const body = (await req.json().catch(() => ({}))) as {
    name?: string
    parentId?: string | null
  }

  const data: Record<string, unknown> = {}
  if (typeof body.name === 'string' && body.name.trim().length > 0) {
    data.name = body.name.trim()
  }
  if (body.parentId === null) {
    data.parentId = null
  } else if (typeof body.parentId === 'string' && body.parentId.length > 0) {
    // Don't allow a folder to become its own descendant.
    if (body.parentId === id) {
      return NextResponse.json(
        { error: "A folder can't be its own parent" },
        { status: 400 }
      )
    }
    // Walk up the proposed parent's chain — if we find this folder, it
    // would create a cycle. Annotated explicitly because TS struggles to
    // infer the parentId type across the loop's await boundary.
    let cursor: string | null = body.parentId
    const seen = new Set<string>()
    while (cursor && !seen.has(cursor)) {
      if (cursor === id) {
        return NextResponse.json(
          { error: "Can't move a folder into its own descendant" },
          { status: 400 }
        )
      }
      seen.add(cursor)
      const parentRow: { parentId: string | null } | null =
        await prisma.documentFolder.findUnique({
          where: { id: cursor },
          select: { parentId: true },
        })
      cursor = parentRow?.parentId ?? null
    }
    data.parentId = body.parentId
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
  }

  const updated = await prisma.documentFolder.update({ where: { id }, data })
  return NextResponse.json({ ok: true, folder: updated })
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { id } = await ctx.params
  const exists = await prisma.documentFolder.findUnique({ where: { id } })
  if (!exists) return NextResponse.json({ error: 'not found' }, { status: 404 })

  // Child folders + documents cascade via the schema FK (onDelete: Cascade).
  await prisma.documentFolder.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
