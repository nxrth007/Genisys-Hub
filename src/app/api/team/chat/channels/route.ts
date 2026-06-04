import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { CHAT_ALLOWED_ROLES, TEAM_1_CHANNEL_SLUG } from '@/lib/team-chat'

/**
 * GET /api/team/chat/channels
 *
 * Returns the list of channels the caller can see. v1 always
 * returns the single Team #1 general channel; future channels
 * (admins-only, per-team) just need rows + role gating per slug.
 *
 * Self-heals the seed: if the migration somehow didn't run yet but
 * the rest of the deploy did, this endpoint creates the row on
 * first call so the chat surface doesn't 500 with an empty channel
 * list.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role ?? ''
  if (!CHAT_ALLOWED_ROLES.has(role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let channel = await prisma.chatChannel.findUnique({
    where: { slug: TEAM_1_CHANNEL_SLUG },
    select: { id: true, slug: true, name: true, teamNumber: true },
  })
  if (!channel) {
    // Self-heal — the migration's INSERT was the seeding path, but
    // if a fresh database is spun up via prisma db push (dev) the
    // row may not exist. Create on first call so dev/staging works
    // without manual seeding.
    channel = await prisma.chatChannel.create({
      data: {
        slug: TEAM_1_CHANNEL_SLUG,
        name: 'Team #1 General',
        teamNumber: 1,
      },
      select: { id: true, slug: true, name: true, teamNumber: true },
    })
  }

  return NextResponse.json({ channels: [channel] })
}
