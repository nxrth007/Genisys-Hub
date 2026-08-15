import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { withOwnerApi, externalOptions } from '@/lib/external-api'

/**
 * GET /api/external/v1/inbox — email headers and snippet only.
 * bodyText / bodyHtml are deliberately never selected.
 */
export const GET = withOwnerApi(async () => {
  const emails = await prisma.email.findMany({
    orderBy: { date: 'desc' },
    take: 40,
    select: {
      id: true,
      from: true,
      fromName: true,
      subject: true,
      snippet: true,
      date: true,
      isRead: true,
      isLead: true,
      category: true,
      folder: true,
    },
  })
  return emails
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
