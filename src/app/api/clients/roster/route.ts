import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { listSubAccounts, friendlyNameFromVaultName, type SubAccount } from '@/lib/ghl'

/**
 * GET /api/clients/roster
 *
 * The client roster as the Clients page needs it now that clients come
 * in through the onboarding form: each Client with its most recent
 * intake attached. No appointment counting, no sheet reads — those
 * belonged to the booking era and made /with-counts slow for nothing.
 *
 * Each client is also matched to its GHL sub-account when the vault
 * holds one: by an explicit `client=<name>` in the vault entry's
 * description, else by the entry's friendly name / location name
 * matching the client's name. Best-effort — a vault or GHL hiccup
 * leaves the link empty rather than failing the page.
 *
 * Staff-only (admin + member).
 */

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(llc|inc|co|corp|ltd|the|and)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

function subAccountFor(name: string, subs: SubAccount[]): SubAccount | null {
  const n = norm(name)
  if (!n) return null
  return (
    subs.find((s) => s.clientHint && norm(s.clientHint) === n) ??
    subs.find(
      (s) => norm(friendlyNameFromVaultName(s.vaultName)) === n || norm(s.locationName) === n,
    ) ??
    subs.find((s) => {
      const f = norm(friendlyNameFromVaultName(s.vaultName))
      return f.length >= 4 && (n.includes(f) || f.includes(n))
    }) ??
    null
  )
}
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
      seoSite: { select: { id: true, repoFullName: true, archivedAt: true } },
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
          hasGoogleProfile: true,
          googleProfileLink: true,
          yearStarted: true,
          licenseInfo: true,
          reviewLinks: true,
          files: true,
        },
      },
    },
  })

  let clientSubs: SubAccount[] = []
  try {
    clientSubs = (await listSubAccounts({ kind: 'client' })).subaccounts
  } catch (err) {
    console.warn('[clients/roster] client sub-account lookup failed:', err)
  }

  return NextResponse.json({
    clients: clients.map(({ intakes, seoSite, ...c }) => {
      const i = intakes[0]
      const sub = subAccountFor(c.name, clientSubs)
      return {
        ...c,
        // The GitHub repo the client's site lives in (held by their SEO site).
        seo: seoSite && !seoSite.archivedAt ? { siteId: seoSite.id, repoFullName: seoSite.repoFullName } : null,
        createdAt: c.createdAt.toISOString(),
        archivedAt: c.archivedAt ? c.archivedAt.toISOString() : null,
        intake: i ? { ...i, receivedAt: i.receivedAt.toISOString() } : null,
        ghlSubAccount: sub
          ? { vaultName: sub.vaultName, locationId: sub.locationId, locationName: sub.locationName }
          : null,
      }
    }),
  })
}
