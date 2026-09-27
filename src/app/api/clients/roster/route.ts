import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/clients/roster
 *
 * The client roster as the Clients page needs it now that clients come
 * in through the onboarding form: each Client with its most recent
 * intake attached. No appointment counting, no sheet reads — those
 * belonged to the booking era and made /with-counts slow for nothing.
 *
 * Staff-only (admin + member).
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const clients = await prisma.client.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      lifecycle: true,
      contactName: true,
      contactEmail: true,
      contactPhone: true,
      address: true,
      website: true,
      siteUrl: true,
      notes: true,
      onboardingNotes: true,
      ghlSubaccountUrl: true,
      createdAt: true,
      archivedAt: true,
      intakes: {
        orderBy: { receivedAt: 'desc' },
        take: 1,
        select: {
          id: true,
          receivedAt: true,
          ein: true,
          fullName: true,
          businessName: true,
          businessContact: true,
          businessAddress: true,
          customerPhone: true,
          areaCode: true,
          timeZone: true,
          leadEmail: true,
          cities: true,
          website: true,
          aboutBusiness: true,
          mainServices: true,
          promotions: true,
          socialLinks: true,
          whyChooseYou: true,
          brandColors: true,
          faqs: true,
          bringingOwnDomain: true,
          domainName: true,
          files: true,
        },
      },
    },
  })

  return NextResponse.json({
    clients: clients.map(({ intakes, ...c }) => {
      const i = intakes[0]
      return {
        ...c,
        createdAt: c.createdAt.toISOString(),
        archivedAt: c.archivedAt ? c.archivedAt.toISOString() : null,
        intake: i ? { ...i, receivedAt: i.receivedAt.toISOString() } : null,
      }
    }),
  })
}
