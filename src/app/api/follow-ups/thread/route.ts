import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/follow-ups/thread?threadKey=gmail:abc123
 *
 * Returns the last ~10 messages of a Gmail thread for the reply
 * drawer. Without this, the drawer only had a 200-char snippet of
 * the latest message — not enough context for Ethan to write a
 * good reply without bouncing to Gmail.
 *
 * Only handles gmail:* keys today. ghl:* threads click out to
 * /crm/[subName]/[convId] where the existing thread renderer
 * already shows full history.
 */
const MAX_MESSAGES = 10

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const threadKey = req.nextUrl.searchParams.get('threadKey')?.trim() ?? ''
  if (!threadKey.startsWith('gmail:')) {
    return NextResponse.json(
      { error: 'threadKey must be a gmail:* key (GHL threads use /crm)' },
      { status: 400 },
    )
  }

  const gmailThreadId = threadKey.slice('gmail:'.length)
  const messages = await prisma.email.findMany({
    where: { threadId: gmailThreadId },
    orderBy: { date: 'asc' },
    take: MAX_MESSAGES,
    select: {
      id: true,
      from: true,
      fromName: true,
      to: true,
      subject: true,
      snippet: true,
      bodyText: true,
      date: true,
      folder: true,
    },
  })

  return NextResponse.json({
    messages: messages.map((m) => ({
      id: m.id,
      from: m.from,
      fromName: m.fromName,
      to: m.to,
      subject: m.subject,
      // Prefer bodyText if present (real email body, not the truncated
      // snippet). Trim to 2KB so the drawer doesn't choke on absurdly
      // long emails — admin can open Gmail directly for the full thing.
      body: (m.bodyText || m.snippet || '').slice(0, 2000),
      date: m.date.toISOString(),
      direction:
        m.folder === 'sent' ? ('outbound' as const) : ('inbound' as const),
    })),
  })
}
