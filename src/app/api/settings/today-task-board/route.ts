import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

const KEY = 'today_task_board_db_id'

/**
 * GET  /api/settings/today-task-board   → { dbId: string | null }
 * PUT  /api/settings/today-task-board   body: { dbId: string | null }
 *
 * Stores which Notion database should render as the Kanban on the Today
 * page. `dbId: null` unpins.
 */

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } })
  return NextResponse.json({ dbId: row?.value || null })
}

export async function PUT(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const body = (await req.json().catch(() => ({}))) as { dbId?: string | null }
  if (body.dbId === null || body.dbId === '') {
    await prisma.appSetting.deleteMany({ where: { key: KEY } })
    return NextResponse.json({ dbId: null })
  }
  if (typeof body.dbId !== 'string') {
    return NextResponse.json({ error: 'dbId must be a string or null' }, { status: 400 })
  }
  await prisma.appSetting.upsert({
    where: { key: KEY },
    update: { value: body.dbId },
    create: { key: KEY, value: body.dbId },
  })
  return NextResponse.json({ dbId: body.dbId })
}
