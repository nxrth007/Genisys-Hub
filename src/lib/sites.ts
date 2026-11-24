/**
 * The Sites page: one folder per client on the roster (a Genisys OS
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
import { DOMAIN_GUARD_KEY_PREFIX } from '@/lib/seo/domain-guard-plan'
import { GSC_CONNECT_KEY, GSC_HEALTH_KEY, connectReasons, connectedAt, googleVerdict, storedSites, type GoogleVerdict } from '@/lib/seo/google-verdict'
import type { DomainGuardState } from '@/lib/seo/domain-guard'

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
  /** Google's verdict on their site, for the list: `flagged` = its domain was connected a week ago and Google still hasn't indexed it. Null without a site. */
  google: Pick<GoogleVerdict, 'state' | 'label' | 'text' | 'flagged' | 'daysConnected'> | null
}

const ON_ROSTER = {
  archivedAt: null,
  lifecycle: { notIn: ['churned', 'denied'] },
  hlAccount: { is: { archivedAt: null } },
}

export async function listSiteFolders(): Promise<SiteFolder[]> {
  const [clients, google] = await Promise.all([
    prisma.client.findMany({
      where: ON_ROSTER,
      select: {
        id: true,
        name: true,
        contactName: true,
        color: true,
        siteUrl: true,
        siteLiveAt: true,
        ghlLocationId: true,
        hlAccount: { select: { profile: true, numbers: { where: { status: 'active' }, select: { kind: true, verificationStatus: true } } } },
        hlNumberRequest: { select: { status: true, route: true } },
        ghlNumberCensus: { select: { locationId: true, state: true, version: true, numbers: true } },
        journeyStages: { where: { stage: 'website' }, select: { status: true } },
        seoSite: { select: { id: true, archivedAt: true, liveUrl: true, gscProperty: true, createdAt: true } },
        hlSiteRequest: { select: { domainAt: true } },
      },
    }),
    googleInputs(),
  ])
  const now = new Date()
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
        // GHL's "Verification Required", or a Genisys OS toll-free number Twilio hasn't approved yet.
        cantText: (phone === 'ghl' && cantTextYet(readCensusNumbers(census?.numbers)).length > 0) || (phone === 'hell_level' && hlCantTextYet(hlNumbers)),
        google: c.siteUrl?.trim() ? verdictFor({ site: c.seoSite, clientSiteUrl: c.siteUrl, siteLiveAt: c.siteLiveAt, domainAt: c.hlSiteRequest?.domainAt ?? null }, google, now) : null,
      }
    }),
  )
}

/** The stored Search Console results and the domain guard's dates, read once for a page. */
type GoogleInputs = { stored: ReturnType<typeof storedSites>; connectWhy: Map<string, string>; originSince: Map<string, string> }

async function googleInputs(siteIds?: string[]): Promise<GoogleInputs> {
  const [rows, guards] = await Promise.all([
    prisma.appSetting.findMany({ where: { key: { in: [GSC_HEALTH_KEY, GSC_CONNECT_KEY] } }, select: { key: true, value: true } }).catch(() => []),
    prisma.appSetting
      .findMany({ where: siteIds ? { key: { in: siteIds.map((id) => `${DOMAIN_GUARD_KEY_PREFIX}${id}`) } } : { key: { startsWith: DOMAIN_GUARD_KEY_PREFIX } }, select: { key: true, value: true } })
      .catch(() => []),
  ])
  const originSince = new Map<string, string>()
  for (const g of guards) {
    const since = readGuardState(g.value)?.originSince
    if (since) originSince.set(g.key.slice(DOMAIN_GUARD_KEY_PREFIX.length), since)
  }
  const value = (key: string) => rows.find((r) => r.key === key)?.value ?? null
  return { stored: storedSites(value(GSC_HEALTH_KEY)), connectWhy: connectReasons(value(GSC_CONNECT_KEY)), originSince }
}

/** Google's verdict on one client's site (src/lib/seo/google-verdict.ts). */
function verdictFor(
  c: {
    site: { id: string; archivedAt: Date | null; liveUrl: string | null; gscProperty: string | null; createdAt: Date } | null
    clientSiteUrl: string | null
    siteLiveAt: Date | null
    domainAt: Date | null
  },
  g: GoogleInputs,
  now: Date,
): GoogleVerdict | null {
  if (!c.site || c.site.archivedAt) return null
  return googleVerdict({
    liveUrl: c.site.liveUrl ?? c.clientSiteUrl,
    property: c.site.gscProperty,
    stored: g.stored.get(c.site.id),
    connectWhy: g.connectWhy.get(c.site.id),
    connectedAt: connectedAt({
      originSince: g.originSince.get(c.site.id),
      domainAt: c.domainAt?.toISOString(),
      siteLiveAt: c.siteLiveAt?.toISOString(),
      siteCreatedAt: c.site.createdAt.toISOString(),
    }),
    now,
  })
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
  client: { id: string; name: string; person: string | null; color: string; siteUrl: string | null; siteLiveAt: string | null; lifecycle: string; archivedAt: string | null }
  status: SiteStatus
  /** The Status card's rows: the journey stages, plus their Genisys OS sub-account (`href` opens it). */
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
    /** hl = a Genisys OS number on Genisys's Twilio; ghl = in the client's GHL sub-account. */
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
  /** Their SEO site: the repo it commits to (the folder's Repo picker), the Lovable project. `siteId` opens it in SEO. */
  seo: { siteId: string; repo: string | null; lovableProjectId: string | null; archived: boolean } | null
  /**
   * Does the live site tell Google its own domain (canonical links, sitemap)? The domain
   * guard's last look and fix (src/lib/seo/domain-guard.ts); `searchConsole` is the property
   * the Hub added the site to. Null without an SEO site.
   */
  google: {
    siteId: string
    status: DomainGuardState['status'] | 'unchecked'
    detail: string | null
    prUrl: string | null
    checkedAt: string | null
    fixedAt: string | null
    submitted: string | null
    searchConsole: string | null
    /** Google's side: has it indexed the homepage (the daily Search Console check)? */
    verdict: GoogleVerdict | null
  } | null
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
  /** Their domain for the site, from their Genisys OS Domains (src/lib/hl/site-plan.ts siteDomainChoice). */
  siteDomain: SiteDomainChoice
  /** Forge's "Buy a website domain for X?" question, when it was asked (src/lib/hl/domain-request.ts). */
  domainQuestion: { status: string; detail: string | null; name: string | null } | null
  /**
   * The folder's buttons, the Office's questions answered here (src/lib/hl/folder-plan.ts): pick a
   * domain from Porkbun's suggestions, buy their Genisys OS toll-free number, build the site.
   */
  actions: { domain: FolderDomain; number: FolderNumber; build: FolderBuild }
  /** Where a Genisys OS number bought now would ring and forward texts (src/lib/hl/number-plan.ts). */
  numberTo: { ring: string | null; texts: string | null }
  /**
   * Their site in Lovable, for the folder's builder window: Forge's copy, else the SEO seat's
   * project, and where the site shows now (their connected domain, the published lovable.app
   * address, or the site link in Clients). Null without a Lovable project.
   */
  builder: { projectId: string; siteUrl: string | null } | null
}

export type { GhlRegistrationView }

/** The domain guard's saved state (AppSetting JSON), or null. */
function readGuardState(value: string | null | undefined): DomainGuardState | null {
  if (!value) return null
  try {
    const v = JSON.parse(value) as unknown
    return v && typeof v === 'object' && typeof (v as DomainGuardState).status === 'string' ? (v as DomainGuardState) : null
  } catch {
    return null
  }
}

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
      archivedAt: true,
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
      seoSite: { select: { id: true, repoFullName: true, lovableProjectId: true, archivedAt: true, gscProperty: true, liveUrl: true, createdAt: true } },
      hlSiteRequest: {
        select: { status: true, detail: true, projectId: true, editorUrl: true, projectName: true, prompt: true, liveUrl: true, domain: true, domainStep: true, domainTxt: true, pause: true, domainAt: true, updatedAt: true },
      },
      hlDomainRequest: { select: { status: true, detail: true, name: true, suggestions: true } },
    },
  })
  if (!c) return null
  const [journey, intakes, guardRow, googleData] = await Promise.all([
    getJourney(clientId),
    prisma.clientIntake.count({ where: { clientId } }),
    c.seoSite ? prisma.appSetting.findUnique({ where: { key: `${DOMAIN_GUARD_KEY_PREFIX}${c.seoSite.id}` } }).catch(() => null) : null,
    c.seoSite ? googleInputs([c.seoSite.id]) : null,
  ])
  const guard = readGuardState(guardRow?.value)
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
  // Every GHL number shows "Verification Required" (the last GHL read), and they don't stay on GHL: Purchase and verify applies.
  const ghlCantText = ghlAllUnverified(readCensusNumbers(census?.numbers)) && !staysOnGhl(c.name)
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
      ghlCantText,
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
    client: { id: c.id, name: c.name, person: personName(c.contactName) ?? personName(p?.ownerName), color: c.color, siteUrl: c.siteUrl, siteLiveAt: c.siteLiveAt?.toISOString() ?? null, lifecycle: c.lifecycle, archivedAt: c.archivedAt?.toISOString() ?? null },
    status: siteStatus({ siteUrl: c.siteUrl, websiteStage: website?.status }),
    journey: journey.stages.flatMap((s): SiteDetail['journey'] => {
      const updatedAt = s.updatedAt?.toISOString() ?? null
      const view = stageView(s.stage, { status: s.status, note: s.note, updatedAt }, facts)
      const row = { stage: s.stage, label: STAGE_LABEL[s.stage], status: view.status, note: view.note, updatedAt }
      // Their domain just before the website; their toll-free number just before texting registration.
      if (s.stage === 'website') return [domainRow, row]
      if (s.stage === 'a2p') return [tollFreeRow, row]
      if (s.stage !== 'subaccount') return [row]
      // Their Genisys OS sub-account, just before the GHL one.
      const hl = hellLevelStage(hellLevel)
      const href = c.hlAccount && !c.hlAccount.archivedAt ? `/genisys-os/${c.hlAccount.id}` : null
      return [{ stage: 'hell_level', label: 'Genisys OS sub-account', ...hl, updatedAt: hellLevel?.createdAt ?? null, href }, row]
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
    seo: c.seoSite ? { siteId: c.seoSite.id, repo: c.seoSite.repoFullName, lovableProjectId: c.seoSite.lovableProjectId, archived: !!c.seoSite.archivedAt } : null,
    google:
      c.seoSite && !c.seoSite.archivedAt
        ? {
            siteId: c.seoSite.id,
            status: guard?.status ?? 'unchecked',
            detail: guard?.detail ?? null,
            prUrl: guard?.prUrl ?? null,
            checkedAt: guard?.checkedAt ?? null,
            fixedAt: guard?.fixedAt ?? null,
            submitted: guard?.submitted ?? null,
            searchConsole: c.seoSite.gscProperty,
            verdict: googleData ? verdictFor({ site: c.seoSite, clientSiteUrl: c.siteUrl, siteLiveAt: c.siteLiveAt, domainAt: c.hlSiteRequest?.domainAt ?? null }, googleData, new Date()) : null,
          }
        : null,
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
