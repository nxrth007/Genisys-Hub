/**
 * The Sites page: one folder per client on the roster (a Hell-level
 * sub-account that isn't archived, a client that isn't archived, churned or
 * denied), with whether their website is live, and for one client the
 * status, links and toll-free number the site build needs.
 */
import { prisma } from '@/lib/prisma'
import { getJourney, type JourneyStage } from '@/lib/client-journey'
import { readProfile } from '@/lib/hl/accounts'
import { siteStatus, sortFolders, type SiteStatus } from '@/lib/site-status'

export type SiteFolder = {
  id: string
  name: string
  color: string
  siteUrl: string | null
  status: SiteStatus
  logoUrl: string | null
}

const ON_ROSTER = {
  archivedAt: null,
  lifecycle: { notIn: ['churned', 'denied'] },
  hlAccount: { is: { archivedAt: null } },
}

export async function listSiteFolders(): Promise<SiteFolder[]> {
  const clients = await prisma.client.findMany({
    where: ON_ROSTER,
    select: {
      id: true,
      name: true,
      color: true,
      siteUrl: true,
      hlAccount: { select: { profile: true } },
      journeyStages: { where: { stage: 'website' }, select: { status: true } },
    },
  })
  return sortFolders(
    clients.map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      siteUrl: c.siteUrl,
      status: siteStatus({ siteUrl: c.siteUrl, websiteStage: c.journeyStages[0]?.status }),
      logoUrl: readProfile(c.hlAccount?.profile).logoUrl || null,
    })),
  )
}

const STAGE_LABEL: Record<JourneyStage, string> = {
  signup: 'Signed up',
  intake: 'Onboarding form',
  subaccount: 'GHL sub-account',
  website: 'Website',
  a2p: 'Texting registration',
  qa: 'Tracker & QA',
}

export type SiteDetail = {
  client: { id: string; name: string; color: string; siteUrl: string | null; siteLiveAt: string | null; lifecycle: string }
  status: SiteStatus
  journey: { stage: string; label: string; status: string; note: string | null; updatedAt: string | null }[]
  account: {
    id: string
    businessName: string | null
    businessPhone: string | null
    notifyPhone: string | null
    notifyEmail: string | null
    address: string | null
    logoUrl: string | null
  } | null
  number: {
    number: string
    forwardTo: string | null
    forwardTextsTo: string | null
    verificationStatus: string
    verificationNote: string | null
  } | null
  request: { status: string; detail: string | null; verifyNote: string | null } | null
  seo: { repo: string | null; lovableProjectId: string | null } | null
}

export async function getSiteDetail(clientId: string): Promise<SiteDetail | null> {
  const c = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      name: true,
      color: true,
      siteUrl: true,
      siteLiveAt: true,
      lifecycle: true,
      hlAccount: {
        select: {
          id: true,
          profile: true,
          numbers: { where: { status: 'active' }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] },
        },
      },
      hlNumberRequest: { select: { status: true, detail: true, verifyNote: true } },
      seoSite: { select: { repoFullName: true, lovableProjectId: true } },
    },
  })
  if (!c) return null
  const journey = await getJourney(clientId)
  const website = journey.stages.find((s) => s.stage === 'website')
  const p = c.hlAccount ? readProfile(c.hlAccount.profile) : null
  // The number for the site: the toll-free one, else whatever the sub-account texts from.
  const numbers = c.hlAccount?.numbers ?? []
  const n = numbers.find((x) => x.kind === 'toll_free') ?? numbers[0] ?? null
  return {
    client: { id: c.id, name: c.name, color: c.color, siteUrl: c.siteUrl, siteLiveAt: c.siteLiveAt?.toISOString() ?? null, lifecycle: c.lifecycle },
    status: siteStatus({ siteUrl: c.siteUrl, websiteStage: website?.status }),
    journey: journey.stages.map((s) => ({ stage: s.stage, label: STAGE_LABEL[s.stage], status: s.status, note: s.note, updatedAt: s.updatedAt?.toISOString() ?? null })),
    account:
      c.hlAccount && p
        ? {
            id: c.hlAccount.id,
            businessName: p.businessName || null,
            businessPhone: p.businessPhone || null,
            notifyPhone: p.notifyPhone || null,
            notifyEmail: p.notifyEmail || null,
            address: p.address || null,
            logoUrl: p.logoUrl || null,
          }
        : null,
    number: n
      ? { number: n.number, forwardTo: n.forwardTo, forwardTextsTo: n.forwardTextsTo, verificationStatus: n.verificationStatus, verificationNote: n.verificationNote }
      : null,
    request: c.hlNumberRequest,
    seo: c.seoSite ? { repo: c.seoSite.repoFullName, lovableProjectId: c.seoSite.lovableProjectId } : null,
  }
}
