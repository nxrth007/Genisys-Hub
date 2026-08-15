import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { withOwnerApi, externalOptions } from '@/lib/external-api'

/**
 * GET /api/external/v1/inbox/:id — one email, with its body.
 *
 * The list endpoint deliberately omits bodies (they are large and mostly
 * unread); this returns the full message for the one you opened.
 */
export const GET = withOwnerApi(async (req, auth) => {
  if (!auth.user) {
    throw new Error('Reading email bodies requires a signed-in account.')
  }

  const id = req.nextUrl.pathname.split('/').pop() ?? ''
  const email = await prisma.email.findUnique({
    where: { id },
    select: {
      id: true,
      from: true,
      fromName: true,
      to: true,
      subject: true,
      bodyText: true,
      bodyHtml: true,
      snippet: true,
      date: true,
      isRead: true,
      isLead: true,
      category: true,
      folder: true,
      threadId: true,
    },
  })

  if (!email) throw new Error('Email not found.')
  return email
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
