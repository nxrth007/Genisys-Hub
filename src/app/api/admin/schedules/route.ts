import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET  /api/admin/schedules
 * POST /api/admin/schedules
 *   body: {
 *     userEmail:      string   // the Hub user the schedule is for (must exist)
 *     timeOfDay:      string   // "09:00" in user's timezone
 *     channel:        'slack' | 'ghl_sms'
 *     recipientPhone: string?  // required when channel=ghl_sms
 *     notionAssignee: string?  // filter Kanban tasks by assignee name
 *     includeTasks:   boolean? (default true)
 *     includeMeetings: boolean? (default true)
 *     enabled:        boolean? (default true)
 *   }
 *   Upserts by (userId, channel) so configuring Ethan's SMS brief twice
 *   replaces rather than duplicates.
 *
 * DELETE /api/admin/schedules?id=<id>
 *
 * Admin-only — middleware enforces role=admin.
 */

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const schedules = await prisma.scheduledSms.findMany({
    include: { user: { select: { id: true, email: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  })
  return NextResponse.json({ schedules })
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    userEmail?: string
    timeOfDay?: string
    channel?: 'slack' | 'ghl_sms'
    recipientPhone?: string | null
    notionAssignee?: string | null
    includeTasks?: boolean
    includeMeetings?: boolean
    enabled?: boolean
  }

  if (!body.userEmail) {
    return NextResponse.json({ error: 'userEmail required' }, { status: 400 })
  }
  if (!body.timeOfDay || !/^\d{2}:\d{2}$/.test(body.timeOfDay)) {
    return NextResponse.json(
      { error: 'timeOfDay required in HH:MM format (24-hour)' },
      { status: 400 }
    )
  }
  const channel = body.channel === 'ghl_sms' ? 'ghl_sms' : 'slack'
  if (channel === 'ghl_sms' && !body.recipientPhone) {
    return NextResponse.json(
      { error: 'recipientPhone required when channel=ghl_sms' },
      { status: 400 }
    )
  }

  const user = await prisma.user.findUnique({
    where: { email: body.userEmail.toLowerCase() },
  })
  if (!user) {
    return NextResponse.json(
      { error: `No Hub user with email ${body.userEmail}. Sign them in once first.` },
      { status: 404 }
    )
  }

  // Upsert by (userId, channel). Prisma doesn't have that compound unique so
  // we find-then-update/create manually.
  const existing = await prisma.scheduledSms.findFirst({
    where: { userId: user.id, channel },
  })

  const data = {
    userId: user.id,
    timeOfDay: body.timeOfDay,
    channel,
    recipientPhone: channel === 'ghl_sms' ? body.recipientPhone ?? null : null,
    notionAssignee: body.notionAssignee ?? null,
    includeTasks: body.includeTasks ?? true,
    includeMeetings: body.includeMeetings ?? true,
    enabled: body.enabled ?? true,
  }

  const schedule = existing
    ? await prisma.scheduledSms.update({
        where: { id: existing.id },
        data,
      })
    : await prisma.scheduledSms.create({ data })

  return NextResponse.json({ ok: true, schedule })
}

export async function DELETE(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const id = req.nextUrl.searchParams.get('id')
  if (!id) {
    return NextResponse.json({ error: 'id query required' }, { status: 400 })
  }

  await prisma.scheduledSms.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
