import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * PATCH  /api/admin/secondary-sheets/[id]  — edit a registered sheet
 * DELETE /api/admin/secondary-sheets/[id]  — unregister it
 *
 * PATCH accepts a partial update; only the keys actually present in
 * the body get written. Useful for the inline toggle / inline client
 * select in the settings UI without forcing the caller to round-trip
 * the whole row.
 */
function requireStaff(role: string | undefined): boolean {
  return role === 'admin' || role === 'member'
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (!requireStaff((session.user as { role?: string }).role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await ctx.params
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const existing = await prisma.secondarySheet.findUnique({
    where: { id },
    select: { id: true },
  })
  if (!existing) {
    return NextResponse.json({ error: 'sheet not found' }, { status: 404 })
  }

  const data: Record<string, unknown> = {}
  if (typeof body.tabTitle === 'string') {
    const t = body.tabTitle.trim()
    if (!t) {
      return NextResponse.json(
        { error: 'tabTitle cannot be empty (leave it as the default if unsure)' },
        { status: 400 },
      )
    }
    data.tabTitle = t
  }
  if (typeof body.label === 'string') {
    data.label = body.label.trim() || null
  } else if (body.label === null) {
    data.label = null
  }
  if (typeof body.enabled === 'boolean') {
    data.enabled = body.enabled
  }
  if (typeof body.clientId === 'string') {
    const cid = body.clientId.trim()
    if (!cid) {
      return NextResponse.json(
        { error: 'clientId cannot be empty' },
        { status: 400 },
      )
    }
    const client = await prisma.client.findUnique({
      where: { id: cid },
      select: { id: true },
    })
    if (!client) {
      return NextResponse.json({ error: 'client not found' }, { status: 404 })
    }
    data.clientId = cid
  }
  if (typeof body.columnMappingKey === 'string') {
    if (body.columnMappingKey !== 'yassin') {
      return NextResponse.json(
        {
          error: `Unknown columnMappingKey "${body.columnMappingKey}". Only "yassin" is supported today.`,
        },
        { status: 400 },
      )
    }
    data.columnMappingKey = body.columnMappingKey
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json(
      { error: 'no editable fields supplied' },
      { status: 400 },
    )
  }

  const updated = await prisma.secondarySheet.update({
    where: { id },
    data,
    select: {
      id: true,
      spreadsheetId: true,
      tabTitle: true,
      clientId: true,
      columnMappingKey: true,
      enabled: true,
      label: true,
      createdAt: true,
      updatedAt: true,
      client: { select: { id: true, name: true } },
    },
  })
  return NextResponse.json({ sheet: updated })
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (!requireStaff((session.user as { role?: string }).role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await ctx.params
  const existing = await prisma.secondarySheet.findUnique({
    where: { id },
    select: { id: true, spreadsheetId: true, tabTitle: true },
  })
  if (!existing) {
    return NextResponse.json({ error: 'sheet not found' }, { status: 404 })
  }

  await prisma.secondarySheet.delete({ where: { id } })
  console.log(
    `[secondary-sheets] admin ${session.user.id} unregistered ${existing.spreadsheetId} / ${existing.tabTitle}`,
  )
  return NextResponse.json({ ok: true })
}
