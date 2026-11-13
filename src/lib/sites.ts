/**
 * The Sites page: one folder per client on the roster (a Hell-level
 * sub-account that isn't archived, a client that isn't archived, churned or
 * denied), with whether their website is live, and for one client the
 * status, links and toll-free number the site build needs.
 */
import { prisma } from '@/lib/prisma'
import { registrationView, type GhlRegistrationView } from '@/lib/ghl-number/register-plan'
import { publicFormUrl } from '@/lib/ghl-form/plan'
import { cantTextYet, currentCensus, hlCantTextYet, phoneState, readCensusNumbers, type CensusNumber, type PhoneState } from '@/lib/ghl-number/census-plan'
import { getJourney, type JourneyStage } from '@/lib/client-journey'
import { readProfile } from '@/lib/hl/accounts'
import { siteStatus, sortFolders, stageView, type SiteStatus } from '@/lib/site-status'

export type SiteFolder = {
  id: string
  name: string
  color: string
  siteUrl: string | null
  status: SiteStatus
  logoUrl: string | null
  /** Where their phone number stands; needs = GHL shows none on their sub-account. */
  phone: PhoneState
  /** A number in their GHL sub-account shows "Verification Required": it can't send texts yet. */
  cantText: boolean
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
      ghlLocationId: true,
      hlAccount: { select: { profile: true, numbers: { where: { status: 'active' }, select: { kind: true, verificationStatus: true } } } },
      hlNumberRequest: { select: { status: true, route: true } },
      ghlNumberCensus: { select: { locationId: true, state: true, version: true, numbers: true } },
      journeyStages: { where: { stage: 'website' }, select: { status: true } },
    },
  })
  return sortFolders(
    clients.map((c) => {
      // What the Hub last read of their GHL sub-account's numbers (the daily read).
      const census = currentCensus(c.ghlNumberCensus, c.ghlLocationId)
      const hlNumbers = c.hlAccount?.numbers ?? []
      const phone = phoneState({ hlNumber: hlNumbers.length > 0, request: c.hlNumberRequest, census: census?.state ?? null, ghlLinked: !!c.ghlLocationId })
      return {
        id: c.id,
        name: c.name,
        color: c.color,
        siteUrl: c.siteUrl,
        status: siteStatus({ siteUrl: c.siteUrl, websiteStage: c.journeyStages[0]?.status }),
        logoUrl: readProfile(c.hlAccount?.profile).logoUrl || null,
        phone,
        // GHL's "Verification Required", or a Hell-level toll-free number Twilio hasn't approved yet.
        cantText: (phone === 'ghl' && cantTextYet(readCensusNumbers(census?.numbers)).length > 0) || (phone === 'hell_level' && hlCantTextYet(hlNumbers)),
      }
    }),
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
    /** hl = a Hell-level number on Genisys's Twilio; ghl = in the client's GHL sub-account. */
    where: 'hl' | 'ghl'
    forwardTo: string | null
    forwardTextsTo: string | null
    verificationStatus: string
    verificationNote: string | null
  } | null
  request: { status: string; route: string; detail: string | null; verifyNote: string | null } | null
  /** GHL's toll-free registration, for a number in GHL. */
  ghlRegistration: GhlRegistrationView | null
  /** The snapshot's site form made theirs (src/lib/ghl-form); null without a linked GHL sub-account. */
  siteForm: { status: string | null; detail: string | null; formUrl: string | null; at: string | null; hasShot: boolean } | null
  /** Where their phone number stands (src/lib/ghl-number/census-plan.ts). */
  phone: PhoneState
  /** What the Hub last read of the linked GHL sub-account's numbers; null without a linked sub-account. */
  ghlNumbers: { state: string; numbers: CensusNumber[]; checkedAt: string | null; triedAt: string | null; detail: string | null } | null
  seo: { repo: string | null; lovableProjectId: string | null } | null
}

export type { GhlRegistrationView }

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
      ghlLocationId: true,
      hlAccount: {
        select: {
          id: true,
          profile: true,
          numbers: { where: { status: 'active' }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] },
        },
      },
      hlNumberRequest: { select: { status: true, route: true, number: true, forwardTo: true, detail: true, verifyNote: true } },
      ghlNumberCensus: { select: { locationId: true, state: true, numbers: true, checkedAt: true, triedAt: true, detail: true, version: true } },
      ghlFormJob: { select: { status: true, detail: true, formId: true, updatedAt: true, finishedAt: true, shotStep: true } },
      ghlNumberJob: {
        select: {
          id: true,
          status: true,
          phase: true,
          registration: true,
          regDetail: true,
          regAt: true,
          regFields: true,
          shots: { orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, step: true, createdAt: true } },
        },
      },
      seoSite: { select: { repoFullName: true, lovableProjectId: true } },
    },
  })
  if (!c) return null
  const [journey, intakes] = await Promise.all([getJourney(clientId), prisma.clientIntake.count({ where: { clientId } })])
  const website = journey.stages.find((s) => s.stage === 'website')
  const p = c.hlAccount ? readProfile(c.hlAccount.profile) : null
  // The number for the site: the toll-free one, else whatever the sub-account texts from.
  const numbers = c.hlAccount?.numbers ?? []
  const n = numbers.find((x) => x.kind === 'toll_free') ?? numbers[0] ?? null
  // A client on the GHL route has its number in GHL instead (the Office request records it).
  const ghlNumber = !n && c.hlNumberRequest?.route === 'ghl' && c.hlNumberRequest.status === 'bought' && c.hlNumberRequest.number ? c.hlNumberRequest : null
  const facts = { siteLive: !!c.siteUrl?.trim(), ghlLinked: !!c.ghlLocationId, hasIntake: intakes > 0, texting: n?.kind === 'toll_free' ? n.verificationStatus : null }
  // What the Hub last read of their GHL sub-account's numbers (the daily read; a re-linked sub-account starts over).
  const census = currentCensus(c.ghlNumberCensus, c.ghlLocationId)
  return {
    client: { id: c.id, name: c.name, color: c.color, siteUrl: c.siteUrl, siteLiveAt: c.siteLiveAt?.toISOString() ?? null, lifecycle: c.lifecycle },
    status: siteStatus({ siteUrl: c.siteUrl, websiteStage: website?.status }),
    journey: journey.stages.map((s) => {
      const updatedAt = s.updatedAt?.toISOString() ?? null
      const view = stageView(s.stage, { status: s.status, note: s.note, updatedAt }, facts)
      return { stage: s.stage, label: STAGE_LABEL[s.stage], status: view.status, note: view.note, updatedAt }
    }),
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
      ? { number: n.number, where: 'hl', forwardTo: n.forwardTo, forwardTextsTo: n.forwardTextsTo, verificationStatus: n.verificationStatus, verificationNote: n.verificationNote }
      : ghlNumber
        ? { number: ghlNumber.number!, where: 'ghl', forwardTo: ghlNumber.forwardTo, forwardTextsTo: null, verificationStatus: 'ghl', verificationNote: null }
        : null,
    request: c.hlNumberRequest ? { status: c.hlNumberRequest.status, route: c.hlNumberRequest.route, detail: c.hlNumberRequest.detail, verifyNote: c.hlNumberRequest.verifyNote } : null,
    ghlRegistration: ghlNumber && c.ghlNumberJob ? registrationView(c.ghlNumberJob) : null,
    siteForm: c.ghlLocationId
      ? {
          status: c.ghlFormJob?.status ?? null,
          detail: c.ghlFormJob?.detail ?? null,
          formUrl: c.ghlFormJob?.formId ? publicFormUrl(c.ghlFormJob.formId) : null,
          at: (c.ghlFormJob?.finishedAt ?? c.ghlFormJob?.updatedAt)?.toISOString() ?? null,
          hasShot: !!c.ghlFormJob?.shotStep,
        }
      : null,
    phone: phoneState({
      hlNumber: numbers.length > 0,
      request: c.hlNumberRequest ? { status: c.hlNumberRequest.status, route: c.hlNumberRequest.route } : null,
      census: census?.state ?? null,
      ghlLinked: !!c.ghlLocationId,
    }),
    ghlNumbers: c.ghlLocationId
      ? {
          state: census?.state ?? 'unchecked',
          numbers: readCensusNumbers(census?.numbers),
          checkedAt: census?.checkedAt?.toISOString() ?? null,
          triedAt: census?.triedAt.toISOString() ?? null,
          detail: census?.detail ?? null,
        }
      : null,
    seo: c.seoSite ? { repo: c.seoSite.repoFullName, lovableProjectId: c.seoSite.lovableProjectId } : null,
  }
}
