/**
 * The Sites page: one folder per client on the roster (a Hell-level
 * sub-account that isn't archived, a client that isn't archived, churned or
 * denied), with whether their website is live, and for one client the
 * status, links and toll-free number the site build needs.
 */
import { prisma } from '@/lib/prisma'
import { registrationView, type GhlRegistrationView } from '@/lib/ghl-number/register-plan'
import { publicFormUrl } from '@/lib/ghl-form/plan'
import { askView, cantTextYet, currentCensus, ghlAllUnverified, hlCantTextYet, phoneState, readCensusNumbers, type CensusNumber, type PhoneState } from '@/lib/ghl-number/census-plan'
import { readChoices } from '@/lib/hl/domain-plan'
import { staysOnGhl } from '@/lib/hl/widget-swap-plan'
import { folderBuild, folderDomain, folderNumber, type FolderBuild, type FolderDomain, type FolderNumber } from '@/lib/hl/folder-plan'
import { ringTo, textsTo } from '@/lib/hl/number-plan'
import { getJourney, type JourneyStage } from '@/lib/client-journey'
import { readProfile } from '@/lib/hl/accounts'
import { SITE_STATUS_TEXT, siteDomainChoice, type SiteDomainChoice, type SiteStatus as BuildStatus } from '@/lib/hl/site-plan'
import { readSavedPause, type SitePause } from '@/lib/hl/site-pause'
import { domainStage, hellLevelStage, personName, siteHost, siteHref, siteStatus, sortFolders, stageView, tollFreeStage, type SiteStatus } from '@/lib/site-status'

export type SiteFolder = {
  id: string
  name: string
  /** The client themself (the person), under the company name. */
  person: string | null
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
      contactName: true,
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
        person: personName(c.contactName) ?? personName(readProfile(c.hlAccount?.profile).ownerName),
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
  client: { id: string; name: string; person: string | null; color: string; siteUrl: string | null; siteLiveAt: string | null; lifecycle: string }
  status: SiteStatus
  /** The Status card's rows: the journey stages, plus their Hell-level sub-account (`href` opens it). */
  journey: { stage: string; label: string; status: string; note: string | null; updatedAt: string | null; href?: string | null }[]
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
  /** Forge's website build in Lovable (src/lib/hl/site-request.ts); null before it was ever asked. */
  build: {
    status: string
    label: string
    detail: string | null
    editorUrl: string | null
    projectName: string | null
    hasPrompt: boolean
    liveUrl: string | null
    /** The domain being (or that was) connected, the connect step, and whether Lovable's code is in. */
    domain: string | null
    domainStep: string | null
    hasCode: boolean
    /** What Lovable is paused on for a person, with Forge's suggestion (src/lib/hl/site-pause.ts). */
    pause: SitePause | null
    updatedAt: string
  } | null
  /** A GHL sub-account is linked: set up in GHL, so the website question needs "ask anyway". */
  ghlLinked: boolean
  /** Their domain for the site, from their Hell-level Domains (src/lib/hl/site-plan.ts siteDomainChoice). */
  siteDomain: SiteDomainChoice
  /** Forge's "Buy a website domain for X?" question, when it was asked (src/lib/hl/domain-request.ts). */
  domainQuestion: { status: string; detail: string | null; name: string | null } | null
  /**
   * The folder's buttons, the Office's questions answered here (src/lib/hl/folder-plan.ts): pick a
   * domain from Porkbun's suggestions, buy their Hell-level toll-free number, build the site.
   */
  actions: { domain: FolderDomain; number: FolderNumber; build: FolderBuild }
  /** Where a Hell-level number bought now would ring and forward texts (src/lib/hl/number-plan.ts). */
  numberTo: { ring: string | null; texts: string | null }
  /**
   * Their site in Lovable, for the folder's builder window: Forge's copy, else the SEO seat's
   * project, and where the site shows now (their connected domain, the published lovable.app
   * address, or the site link in Clients). Null without a Lovable project.
   */
  builder: { projectId: string; siteUrl: string | null } | null
}

export type { GhlRegistrationView }

export async function getSiteDetail(clientId: string): Promise<SiteDetail | null> {
  const c = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      name: true,
      contactName: true,
      color: true,
      siteUrl: true,
      siteLiveAt: true,
      lifecycle: true,
      ghlLocationId: true,
      hlAccount: {
        select: {
          id: true,
          profile: true,
          archivedAt: true,
          createdAt: true,
          numbers: { where: { status: 'active' }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] },
          domains: { orderBy: { createdAt: 'asc' }, select: { name: true, origin: true, status: true, createdAt: true } },
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
      hlSiteRequest: {
        select: { status: true, detail: true, projectId: true, editorUrl: true, projectName: true, prompt: true, liveUrl: true, domain: true, domainStep: true, domainTxt: true, pause: true, updatedAt: true },
      },
      hlDomainRequest: { select: { status: true, detail: true, name: true, suggestions: true } },
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
  const hellLevel = c.hlAccount ? { createdAt: c.hlAccount.createdAt.toISOString(), archived: !!c.hlAccount.archivedAt } : null
  const facts = { siteLive: !!c.siteUrl?.trim(), ghlLinked: !!c.ghlLocationId, hellLevel, hasIntake: intakes > 0, texting: n?.kind === 'toll_free' ? n.verificationStatus : null }
  // What the Hub last read of their GHL sub-account's numbers (the daily read; a re-linked sub-account starts over).
  const census = currentCensus(c.ghlNumberCensus, c.ghlLocationId)
  const forge = c.hlSiteRequest
  const lovableProject = forge?.projectId ?? c.seoSite?.lovableProjectId ?? null
  const forgeLive = forge && ['published', 'connecting', 'connected'].includes(forge.status) ? forge.liveUrl : null
  const builderSite = forge?.status === 'connected' && forge.domain ? `https://${forge.domain}` : (forgeLive ?? (c.siteUrl?.trim() ? siteHref(c.siteUrl.trim()) : null))
  // The folder's buttons: the same rules src/lib/hl/folder-actions.ts checks again before acting.
  const hasAccount = !!c.hlAccount && !c.hlAccount.archivedAt
  // The Status card's "Domain purchased" and "Toll-Free Number Purchased & Verified" rows (Alex, 2026-11-14).
  const ownHost = siteHost(c.siteUrl)
  const domainRow = {
    stage: 'domain',
    label: 'Domain purchased',
    ...domainStage({
      domains: (c.hlAccount?.domains ?? []).map((x) => ({ ...x, createdAt: x.createdAt.toISOString() })),
      question: c.hlDomainRequest ? { status: c.hlDomainRequest.status, name: c.hlDomainRequest.name, detail: c.hlDomainRequest.detail } : null,
      siteHost: ownHost && !/(^|\.)(lovable\.app|lovableproject\.com|onrender\.com)$/i.test(ownHost) ? ownHost : null,
    }),
    updatedAt: null,
  }
  const tollFree = numbers.find((x) => x.kind === 'toll_free') ?? null
  const tollFreeRow = {
    stage: 'toll_free',
    label: 'Toll-Free Number Purchased & Verified',
    ...tollFreeStage({
      number: tollFree ? { number: tollFree.number, verificationStatus: tollFree.verificationStatus, verificationNote: tollFree.verificationNote } : null,
      ghl: ghlNumber ? { number: ghlNumber.number!, registration: c.ghlNumberJob?.registration ?? null } : null,
      request: c.hlNumberRequest ? { status: c.hlNumberRequest.status, detail: c.hlNumberRequest.detail } : null,
      ghlLinked: !!c.ghlLocationId,
      siteLive: facts.siteLive,
    }),
    updatedAt: null,
  }
  const actions = {
    domain: folderDomain({
      hasAccount,
      hasDomain: (c.hlAccount?.domains ?? []).some((x) => x.status !== 'failed'),
      status: c.hlDomainRequest?.status ?? null,
      choices: readChoices(c.hlDomainRequest?.suggestions),
      buying: c.hlDomainRequest?.name ?? null,
    }),
    number: folderNumber({
      hasAccount,
      hasTollFree: numbers.some((x) => x.kind === 'toll_free'),
      ghlHasNumber: askView(c.ghlNumberCensus, c.ghlLocationId) === 'has',
      ghlCantText: ghlAllUnverified(readCensusNumbers(census?.numbers)),
      staysOnGhl: staysOnGhl(c.name),
      status: c.hlNumberRequest?.status ?? null,
    }),
    build: folderBuild({ hasAccount, ghlLinked: !!c.ghlLocationId, status: forge?.status ?? null }),
  }
  return {
    client: { id: c.id, name: c.name, person: personName(c.contactName) ?? personName(p?.ownerName), color: c.color, siteUrl: c.siteUrl, siteLiveAt: c.siteLiveAt?.toISOString() ?? null, lifecycle: c.lifecycle },
    status: siteStatus({ siteUrl: c.siteUrl, websiteStage: website?.status }),
    journey: journey.stages.flatMap((s): SiteDetail['journey'] => {
      const updatedAt = s.updatedAt?.toISOString() ?? null
      const view = stageView(s.stage, { status: s.status, note: s.note, updatedAt }, facts)
      const row = { stage: s.stage, label: STAGE_LABEL[s.stage], status: view.status, note: view.note, updatedAt }
      // Their domain just before the website; their toll-free number just before texting registration.
      if (s.stage === 'website') return [domainRow, row]
      if (s.stage === 'a2p') return [tollFreeRow, row]
      if (s.stage !== 'subaccount') return [row]
      // Their Hell-level sub-account, just before the GHL one.
      const hl = hellLevelStage(hellLevel)
      const href = c.hlAccount && !c.hlAccount.archivedAt ? `/hell-level/${c.hlAccount.id}` : null
      return [{ stage: 'hell_level', label: 'Hell-level sub-account', ...hl, updatedAt: hellLevel?.createdAt ?? null, href }, row]
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
    build: c.hlSiteRequest
      ? {
          status: c.hlSiteRequest.status,
          label: SITE_STATUS_TEXT[c.hlSiteRequest.status as BuildStatus] ?? c.hlSiteRequest.status,
          // A row from when Forge asked Lovable's chat to connect a domain can quote its markup: no use to a person.
          detail: c.hlSiteRequest.detail && /<lov-[a-z-]+/i.test(c.hlSiteRequest.detail) ? null : c.hlSiteRequest.detail,
          editorUrl: c.hlSiteRequest.editorUrl,
          projectName: c.hlSiteRequest.projectName,
          hasPrompt: !!c.hlSiteRequest.prompt,
          liveUrl: ['published', 'connecting', 'connected'].includes(c.hlSiteRequest.status) ? c.hlSiteRequest.liveUrl : null,
          domain: c.hlSiteRequest.domain,
          domainStep: c.hlSiteRequest.domainStep,
          hasCode: !!c.hlSiteRequest.domainTxt,
          pause: c.hlSiteRequest.status === 'waiting_on_lovable' ? readSavedPause(c.hlSiteRequest.pause) : null,
          updatedAt: c.hlSiteRequest.updatedAt.toISOString(),
        }
      : null,
    ghlLinked: !!c.ghlLocationId,
    siteDomain: siteDomainChoice(c.hlAccount?.domains ?? []),
    domainQuestion: c.hlDomainRequest ? { status: c.hlDomainRequest.status, detail: c.hlDomainRequest.detail, name: c.hlDomainRequest.name } : null,
    builder: lovableProject ? { projectId: lovableProject, siteUrl: builderSite } : null,
    actions,
    numberTo: p ? { ring: ringTo(p), texts: textsTo(p) } : { ring: null, texts: null },
  }
}
