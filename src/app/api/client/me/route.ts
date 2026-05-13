import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/client/me
 *
 * Lightweight "who am I" for client_* sessions. Used by the payment
 * step to know which package the caller picked, and by anything else
 * client-side that needs the linked Client without re-querying via
 * /api/client/appointments. No appointment data here — keeps the
 * response small.
 *
 * We re-read User.name (and email) from the DB instead of trusting
 * session.user.* directly. Why: NextAuth's JWT is issued at sign-in
 * (or registration) and caches whatever the User row had at that
 * moment. The onboarding-form submission writes the client's full
 * name onto User.name AFTER they signed in — but the JWT in the
 * cookie still has the old null name. /client/account would render
 * "Not set" forever otherwise (Alex hit this on 2026-05-13). The
 * fresh DB read is a single keyed lookup; cheap.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  // Any client_* role is allowed — the caller might be in
  // onboarding (mid-funnel) rather than active.
  if (!session.user.role?.startsWith('client_')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const userId = session.user.id
  const clientId = session.user.clientId

  const [freshUser, client] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, role: true },
    }),
    clientId
      ? prisma.client.findUnique({
          where: { id: clientId },
          select: {
            id: true,
            name: true,
            state: true,
            package: true,
            lifecycle: true,
            contactName: true,
            apptCap: true,
            slackChannelId: true,
            slackChannelName: true,
          },
        })
      : Promise.resolve(null),
  ])

  // Fall back to session values if the user row vanished between
  // session issue and now (shouldn't happen, but defend against it
  // so the page doesn't crash on a half-deleted account).
  return NextResponse.json({
    user: {
      id: userId,
      email: freshUser?.email ?? session.user.email,
      name: freshUser?.name ?? session.user.name,
      role: freshUser?.role ?? session.user.role,
    },
    client,
  })
}
