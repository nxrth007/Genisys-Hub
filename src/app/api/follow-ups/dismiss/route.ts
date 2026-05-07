import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { dismissFollowUp } from '@/lib/follow-ups'

/**
 * POST /api/follow-ups/dismiss
 *
 * Body: { threadKey: string, contactLabel?: string }
 *
 * Marks a follow-up candidate as handled for the calling user.
 * Idempotent — duplicate dismissals are no-ops via the unique
 * (userId, threadKey) constraint.
 */
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: { threadKey?: string; contactLabel?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const threadKey = typeof body.threadKey === 'string' ? body.threadKey.trim() : ''
  if (!threadKey) {
    return NextResponse.json(
      { error: 'threadKey is required' },
      { status: 400 },
    )
  }

  await dismissFollowUp({
    userId: session.user.id,
    threadKey,
    contactLabel:
      typeof body.contactLabel === 'string' ? body.contactLabel : null,
  })

  return NextResponse.json({ ok: true })
}
