/**
 * A new client's website, built in Lovable after a Yes in the Office (Alex,
 * 2026-11-13: run Ethan's site build on Render after onboarding, with the
 * Hell-level quote form and chat on every new site).
 *
 * Right after onboarding makes the client's Hell-level sub-account, Forge
 * (the website-build bot) asks in the Office: build their website?
 * (./site-plan.ts decides who.) A Claude call and Lovable credits cost
 * money, so nothing runs until a person presses Build it. Then one step at a
 * time, each saved before the next, so a restart carries on where it stopped:
 *
 *   filling  — Claude fills Ethan's one-shot from the onboarding answers and
 *              photos (./site-fill.ts); the kit's quote form and chat widget
 *              go in where GHL's were (./site-template.ts).
 *   copying  — the Hub's Lovable sign-in copies the template project (Robert
 *              Taylor's site) into the template's workspace, named after the
 *              owner the way Ethan names his copies. Free.
 *   sending  — the one-shot goes to the copy's agent. Lovable credits.
 *   building — every minute the scheduler asks Lovable how the agent is doing,
 *              until it's done, stopped, or waiting for a person in its editor.
 *
 * Then the site is built but not published, and Forge asks again in the
 * Office: publish it? A person looks it over in Lovable first. On Publish it:
 *
 *   publishing — the Hub's Lovable sign-in publishes the copy at
 *                <business-name>.lovable.app (free), then checks every minute
 *                until that address loads.
 *
 * Then their domain (Hell-level → Domains: bought through Forge, moved in,
 * or one whose DNS stays elsewhere). If it was there when Publish it was
 * pressed, connecting starts straight after; else Forge asks "Connect
 * acme.com to X's website?" once it appears. On Yes:
 *
 *   connecting — records: Lovable has no API for domains and its chat can't
 *                         connect one (tried 2026-11-14: its agent only has
 *                         read-only domain tools), so a person adds the domain
 *                         in Lovable (Settings → Domains → Connect domain →
 *                         manual) and pastes Lovable's code (lovable_verify=…)
 *                         in their Sites folder or on the domain's page. A
 *                         domain held here gets its DNS set at Porkbun then;
 *                         one elsewhere waits for the records Forge lists.
 *                live:    every few minutes, until the domain shows the site
 *                         (Lovable's certificate can take hours).
 *   connected  — saved as their site link in Clients (policy pages, logo,
 *                texting verification follow).
 *
 * Still by hand: connecting GitHub in Lovable. The site's form and chat link
 * its own /privacy and /terms wherever it's shown (./legal-links.ts).
 */
import { Prisma } from '@/generated/prisma/client'
import { embedCode } from '@/components/hell-level/embed'
import { bestIntake, emailOrBlank, looksLikeAddress, notABusinessName } from '@/lib/automation-copy'
import { textSiteEvent } from '@/lib/ghl-subaccount-worker/alerts'
import { hubLink } from '@/lib/hub-alerts'
import { prisma } from '@/lib/prisma'
import { BudgetExceededError, FatalClaudeError, RefusalError, TruncatedError } from '@/lib/seo/claude'
import {
  LovableMcpError,
  lovableMcpAgentState,
  lovableMcpDeploy,
  lovableMcpFindProjects,
  lovableMcpProjectRef,
  lovableMcpRecentMessages,
  lovableMcpRemix,
  lovableMcpRespond,
  lovableMcpSend,
  lovableMcpStatus,
  type LovableAgentState,
  type LovableProjectRef,
} from '@/lib/seo/lovable-mcp'
import { afterSiteLinkChange, saveSiteLink } from '@/lib/site-link'
import { readProfile, zoneFromAnswers } from './accounts'
import { REVIEW_REQUEST_FORM } from './client-kit'
import { metaOf, siteRecords } from './domain-shared'
import { connectDomain, connectLovable, verifyExternal } from './domains'
import { fillOneShot } from './site-fill'
import {
  answerWords,
  forgeMayAnswer,
  forgeResponse,
  isCopyChatTurn,
  MAX_FORGE_ANSWERS,
  pauseSummary,
  personResponse,
  readPause,
  readSavedPause,
  type SitePause,
} from './site-pause'
import { readPauseAgainstBrief } from './site-pause-read'
import {
  bareHost,
  buildOneShot,
  BUILT_SITE_PAGES,
  cleanDomain,
  DEFAULT_TEMPLATE_PROJECT,
  firstEmail,
  gbpLinkFrom,
  lovableVerifyCodes,
  phoneParts,
  pickPhotos,
  projectNameFor,
  publishSlug,
  siteAskDecision,
  siteDomainChoice,
  siteQuestionDetail,
  SITE_PUBLISHABLE,
  SITE_WORKING,
  socialLinksFrom,
  zoneWord,
  type SiteDomainChoice,
  type SiteEmbeds,
  type SiteFacts,
  type SiteFill,
} from './site-plan'
import { publicBase } from './twilio'

const SINCE_KEY = 'hlSite.since'
const ASK_SWEEP_EVERY_MS = 10 * 60_000
/** How often the scheduler asks Lovable how a build is going. */
const POLL_EVERY_MS = 60_000
/** One runner per build: a step holds the row this long (a copy waits up to 9 minutes, a fill a few). */
const LEASE_MS = 20 * 60_000
/** How long one remix call waits for Lovable's copy. */
const REMIX_WAIT_S = 540
/** After this long without a copy appearing, a person looks in Lovable. */
const COPY_GIVE_UP_MS = 40 * 60_000
/** A build this old gets a note to look at it in Lovable (it keeps being checked). */
const BUILD_SLOW_MS = 4 * 60 * 60_000
/** A publish whose address still doesn't load after this long goes back to a person. */
const PUBLISH_GIVE_UP_MS = 30 * 60_000
/** Lovable's code (and records a person adds elsewhere): asked about this long before it goes back to the question. */
const RECORDS_GIVE_UP_MS = 7 * 24 * 60 * 60_000
/** The domain showing the site: a nudge after a day, back to a person after three (Lovable: certificates past 72 hours go to its support). */
const LIVE_NUDGE_MS = 24 * 60 * 60_000
const LIVE_GIVE_UP_MS = 72 * 60 * 60_000
/** How often waiting on DNS and certificates is checked. */
const DOMAIN_POLL_MS = 5 * 60_000
/** Who the Domains page logs as having set the records. */
const FORGE = 'Forge (website build)'
/** Lovable or Claude not answering: tries of one step before a person is asked to look. */
const MAX_TRIES = 6

type LogEntry = { at: string; what: string }
type SiteRow = Prisma.HlSiteRequestGetPayload<{ include: { client: { select: { name: true } } } }>

/** A stop a person has to deal with (missing details, Lovable refused): no automatic retry. */
class SiteStop extends Error {}

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err))
const templateProject = () => process.env.HL_SITE_TEMPLATE_PROJECT?.trim() || DEFAULT_TEMPLATE_PROJECT
const sitesFolder = (clientId: string) => hubLink(`/sites/${clientId}`)

/** When the website question started: the sweep only asks sub-accounts made since. */
async function siteSince(now = new Date()): Promise<Date> {
  const row = await prisma.appSetting.findUnique({ where: { key: SINCE_KEY } })
  if (row?.value && !Number.isNaN(Date.parse(row.value))) return new Date(row.value)
  try {
    await prisma.appSetting.create({ data: { key: SINCE_KEY, value: now.toISOString() } })
  } catch {
    // Another process recorded it first.
  }
  const again = await prisma.appSetting.findUnique({ where: { key: SINCE_KEY } })
  return new Date(again?.value && !Number.isNaN(Date.parse(again.value)) ? again.value : now.toISOString())
}

async function note(id: string, what: string, data: Prisma.HlSiteRequestUpdateInput = {}) {
  const row = await prisma.hlSiteRequest.findUnique({ where: { id }, select: { log: true } })
  const log = [...((row?.log as LogEntry[] | null) ?? []), { at: new Date().toISOString(), what }].slice(-60)
  await prisma.hlSiteRequest.update({ where: { id }, data: { ...data, log: log as unknown as Prisma.InputJsonValue } })
}

/** Another runner moved the build on first; this one stops quietly. */
class Superseded extends Error {}

/** Move the build on from `from`, only if it's still there (a slow step whose lease ran out must not move it twice). */
async function move(id: string, from: string, what: string, data: Prisma.HlSiteRequestUpdateManyMutationInput) {
  const row = await prisma.hlSiteRequest.findUnique({ where: { id }, select: { log: true } })
  const log = [...((row?.log as LogEntry[] | null) ?? []), { at: new Date().toISOString(), what }].slice(-60)
  const moved = await prisma.hlSiteRequest.updateMany({ where: { id, status: from }, data: { ...data, log: log as unknown as Prisma.InputJsonValue } })
  if (!moved.count) throw new Superseded()
}

// ---------------------------------------------------------------------------
// What the site is built from
// ---------------------------------------------------------------------------

type Gathered = {
  accountId: string
  facts: SiteFacts
  /** The kit's quote form and chat widget, as the site embeds them; null when the sub-account lacks one. */
  embeds: SiteEmbeds | null
  /** What the site can't go without and isn't on file. */
  missing: string[]
  numberAsked: boolean
  domainAsked: boolean
}

/** The client's answers, sub-account profile, number, domain and kit forms, as the one-shot uses them. */
export async function gatherSite(clientId: string): Promise<Gathered | null> {
  const c = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      name: true,
      contactName: true,
      contactPhone: true,
      contactEmail: true,
      address: true,
      website: true,
      hlAccount: {
        select: {
          id: true,
          profile: true,
          timezone: true,
          archivedAt: true,
          forms: { where: { archivedAt: null, kind: { in: ['form', 'chat'] } }, orderBy: { createdAt: 'asc' }, select: { id: true, kind: true, name: true, ghlId: true } },
          numbers: { where: { status: 'active' }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }], select: { number: true, kind: true } },
          domains: { where: { status: { not: 'failed' } }, orderBy: { createdAt: 'asc' }, select: { name: true } },
        },
      },
      hlNumberRequest: { select: { status: true, route: true, number: true } },
      hlDomainRequest: { select: { status: true, name: true } },
      intakes: {
        orderBy: { receivedAt: 'desc' },
        take: 6,
        select: {
          fullName: true,
          businessName: true,
          businessAddress: true,
          customerPhone: true,
          businessContact: true,
          leadEmail: true,
          cities: true,
          timeZone: true,
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
          reviewLinks: true,
          yearStarted: true,
          licenseInfo: true,
          files: true,
        },
      },
    },
  })
  const account = c?.hlAccount && !c.hlAccount.archivedAt ? c.hlAccount : null
  if (!c || !account) return null
  const p = readProfile(account.profile)
  const i = bestIntake(c.intakes)
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()
  const answer = (s: string | null | undefined) => (s ?? '').trim()

  // The number on the site: their toll-free one (Hell-level, or bought in GHL), else their own.
  const hlNumber = account.numbers.find((n) => n.kind === 'toll_free') ?? account.numbers[0] ?? null
  const ghlNumber = c.hlNumberRequest?.route === 'ghl' && c.hlNumberRequest.status === 'bought' ? c.hlNumberRequest.number : null
  const own = phoneParts(p.businessPhone) ?? phoneParts(i?.customerPhone) ?? phoneParts(c.contactPhone) ?? phoneParts(i?.businessContact)
  const phone = phoneParts(hlNumber?.number) ?? phoneParts(ghlNumber) ?? own
  const phoneSource: SiteFacts['phoneSource'] = phoneParts(hlNumber?.number) ? (hlNumber?.kind === 'toll_free' ? 'toll_free' : 'hell_level') : phoneParts(ghlNumber) ? 'ghl' : own ? 'own' : null

  // The domain: one they're bringing, else one on their sub-account (bought through Forge, or connected).
  const ownDomain = /^y(es)?$/i.test(i?.bringingOwnDomain?.trim() ?? '') ? cleanDomain(i?.domainName) : null
  const domain = ownDomain ?? cleanDomain(account.domains[0]?.name) ?? (c.hlDomainRequest?.status === 'bought' ? cleanDomain(c.hlDomainRequest.name) : null)

  // Older intakes have the name and address answers crossed (see profileForClient).
  const crossed = looksLikeAddress(i?.businessName) && !looksLikeAddress(i?.businessAddress)
  const address = clean(p.address) || clean(crossed ? i?.businessName : i?.businessAddress) || clean(c.address)
  const legalName = clean(p.legalName) || (notABusinessName(i?.businessName) ? '' : clean(i?.businessName)) || clean(c.name)
  const { photos, skipped } = pickPhotos(i?.files ?? [])

  const facts: SiteFacts = {
    clientName: c.name,
    legalName,
    businessName: clean(p.businessName) || legalName,
    ownerName: clean(p.ownerName) || clean(i?.fullName) || clean(c.contactName),
    phone,
    phoneSource,
    email: emailOrBlank(firstEmail(i?.leadEmail)) || emailOrBlank(firstEmail(p.notifyEmail)) || emailOrBlank(firstEmail(c.contactEmail)),
    address,
    // Business Profile → Service area first: staff type it there when the onboarding answer isn't a place.
    cities: clean(p.serviceArea) || answer(i?.cities),
    timeZoneAnswer: answer(i?.timeZone),
    timeZoneHint: zoneWord(zoneFromAnswers(i?.timeZone, address) ?? account.timezone),
    currentWebsite: answer(i?.website) || answer(c.website),
    domain,
    about: answer(i?.aboutBusiness),
    mainServices: answer(i?.mainServices),
    whyChooseYou: answer(i?.whyChooseYou),
    promotions: answer(i?.promotions),
    brandColors: answer(i?.brandColors),
    faqs: answer(i?.faqs),
    yearStarted: answer(i?.yearStarted),
    licenseInfo: answer(i?.licenseInfo),
    socialLinks: socialLinksFrom([i?.socialLinks, i?.reviewLinks].filter(Boolean).join('\n')),
    gbpLink: /^no$/i.test(i?.hasGoogleProfile?.trim() ?? '') ? null : gbpLinkFrom([i?.googleProfileLink, i?.reviewLinks].filter(Boolean).join('\n')),
    photos,
    skipped,
  }

  // The kit's forms: the quote form (not the review request form), and the chat widget.
  const native = account.forms.filter((f) => !f.ghlId)
  const quote = native.find((f) => f.kind === 'form' && f.name === 'Website Quote Form') ?? native.find((f) => f.kind === 'form' && f.name !== REVIEW_REQUEST_FORM)
  const chat = native.find((f) => f.kind === 'chat')
  const origin = publicBase()
  const embeds = quote && chat ? { formId: quote.id, formEmbed: embedCode(origin, quote), chatId: chat.id, chatEmbed: embedCode(origin, chat) } : null

  // Claude won't guess where a business works (Cnc transportation, 2026-11-13, stopped after its call):
  // with neither an address nor a service area, the build stops here before anything is spent.
  const missing = [
    !phone && 'phone number',
    !facts.email && 'email address',
    !facts.address.trim() && !facts.cities.trim() && 'address or service area',
    !embeds && 'Hell-level quote form and chat widget',
  ].filter((x): x is string => !!x)
  return {
    accountId: account.id,
    facts,
    embeds,
    missing,
    numberAsked: c.hlNumberRequest?.status === 'awaiting_approval' || c.hlNumberRequest?.status === 'awaiting_identity',
    domainAsked: c.hlDomainRequest?.status === 'awaiting_approval',
  }
}

// ---------------------------------------------------------------------------
// Asking, and the answer
// ---------------------------------------------------------------------------

export type SiteAskResult = { ok: true; status: string; id: string } | { ok: false; reason: string }

/** Put Forge's question in the Office for this client, if it should be asked (./site-plan.ts). */
export async function askForClientSite(clientId: string, trigger: 'onboarding' | 'sweep' | 'manual', opts: { overrideGhl?: boolean; by?: string } = {}): Promise<SiteAskResult> {
  const c = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      name: true,
      archivedAt: true,
      siteUrl: true,
      ghlLocationId: true,
      hlAccount: { select: { id: true, createdAt: true, archivedAt: true } },
      hlSiteRequest: { select: { id: true, status: true, editorUrl: true } },
    },
  })
  if (!c) return { ok: false, reason: 'client not found' }
  const account = c.hlAccount && !c.hlAccount.archivedAt ? c.hlAccount : null
  const decision = siteAskDecision({
    archived: !!c.archivedAt,
    accountId: account?.id ?? null,
    siteLive: !!c.siteUrl?.trim(),
    ghlLinked: !!c.ghlLocationId,
    request: c.hlSiteRequest,
    trigger,
    overrideGhl: opts.overrideGhl,
    accountCreatedAt: account?.createdAt ?? null,
    since: await siteSince(),
  })
  if (!decision.ask || !account) return { ok: false, reason: decision.reason }
  const g = await gatherSite(clientId)
  const detail = g
    ? siteQuestionDetail({ photos: g.facts.photos.length, skipped: g.facts.skipped.length, domain: g.facts.domain, phoneSource: g.facts.phoneSource, numberAsked: g.numberAsked, domainAsked: g.domainAsked, missing: g.missing })
    : null
  const earlier = c.hlSiteRequest?.editorUrl ? ` The earlier copy stays in Lovable: ${c.hlSiteRequest.editorUrl}` : ''
  const who = trigger === 'manual' ? `by ${opts.by ?? 'an admin'}, by hand` : 'after onboarding'
  const data = {
    accountId: account.id,
    status: 'awaiting_approval',
    templateId: null,
    workspaceId: null,
    projectId: null,
    projectName: null,
    editorUrl: null,
    previewUrl: null,
    messageId: null,
    threadId: null,
    prompt: null,
    fill: Prisma.DbNull,
    detail,
    trigger,
    decidedBy: null,
    decidedAt: null,
    stepAt: null,
    leaseUntil: null,
    finishedAt: null,
    liveUrl: null,
    publishedAt: null,
    log: [{ at: new Date().toISOString(), what: `Asked in the Office ${who}.${earlier}` }] as unknown as Prisma.InputJsonValue,
  }
  const row = c.hlSiteRequest
    ? await prisma.hlSiteRequest.update({ where: { id: c.hlSiteRequest.id }, data, select: { id: true } })
    : await prisma.hlSiteRequest.create({ data: { clientId, ...data }, select: { id: true } })
  return { ok: true, status: 'awaiting_approval', id: row.id }
}

export type SiteDecision = { ok: true; status: string; detail: string | null } | { ok: false; reason: string }

/**
 * A person's answer in the Office. To "Build X's website?": Build it (fill,
 * copy, send, watch) or Not now. To "Publish X's website?" once it's built:
 * Publish it, or Not now (it can be published later from their folder). To
 * "Connect acme.com to X's website?" once it's published: Connect it, or Not
 * now (also from their folder later).
 */
export async function decideClientSite(id: string, decision: 'build' | 'publish' | 'connect' | 'no', by: string): Promise<SiteDecision> {
  const r = await prisma.hlSiteRequest.findUnique({ where: { id }, select: { id: true, clientId: true, status: true, projectId: true } })
  if (!r) return { ok: false, reason: 'That question is gone.' }
  if (decision === 'publish' || (decision === 'no' && r.status === 'built')) return decidePublish(r, decision, by)
  if (decision === 'connect' || (decision === 'no' && r.status === 'published')) return decideConnect(r, decision, by)
  if (r.status !== 'awaiting_approval') return { ok: false, reason: (SITE_WORKING as string[]).includes(r.status) ? 'It’s already being built.' : 'That question was already answered.' }
  if (decision === 'no') {
    await note(r.id, `${by} answered Not now.`, { status: 'declined', decidedBy: by, decidedAt: new Date(), detail: null })
    return { ok: true, status: 'declined', detail: 'Not built. Ask again from their folder in Sites.' }
  }
  // Before anything costs money: the Hub has to be signed in to Lovable.
  const lovable = await lovableMcpStatus()
  if (!lovable.connected) return { ok: false, reason: 'The Hub isn’t signed in to Lovable. Connect it on the SEO page (Setup card), then press Build it again.' }
  const now = new Date()
  const claimed = await prisma.hlSiteRequest.updateMany({
    where: { id: r.id, status: 'awaiting_approval' },
    data: { status: 'filling', decidedBy: by, decidedAt: now, stepAt: now, leaseUntil: null, detail: null },
  })
  if (!claimed.count) return { ok: false, reason: 'Someone else just answered it.' }
  await note(r.id, `${by} answered Build it.`)
  void advanceSiteBuild(r.id).catch((err) => console.error(`[hl-site] build ${r.id}:`, err))
  return { ok: true, status: 'filling', detail: 'Started. Claude fills the one-shot, then the Hub copies the template in Lovable and sends it. Forge shows how it’s going.' }
}

/** Forge's second question, once Lovable built the site: Publish it, or Not now. A domain they already have is connected straight after. */
async function decidePublish(r: { id: string; clientId: string; status: string; projectId: string | null }, decision: 'publish' | 'no', by: string): Promise<SiteDecision> {
  if (r.status === 'publishing') return { ok: false, reason: 'It’s already being published.' }
  if (r.status === 'published') return { ok: false, reason: 'It’s already published.' }
  if (!(SITE_PUBLISHABLE as string[]).includes(r.status)) return { ok: false, reason: 'There’s no built site to publish.' }
  if (decision === 'no') {
    const held = await move(r.id, 'built', `${by} answered Not now to publishing.`, { status: 'held', detail: 'Not published. Publish it from their folder in Sites when it’s ready.' }).then(
      () => true,
      () => false,
    )
    return held ? { ok: true, status: 'held', detail: 'Not published. Publish it from their folder in Sites.' } : { ok: false, reason: 'Someone else just answered it.' }
  }
  if (!r.projectId) return { ok: false, reason: 'The Hub lost track of the Lovable copy. Publish it in Lovable instead.' }
  const lovable = await lovableMcpStatus()
  if (!lovable.connected) return { ok: false, reason: 'The Hub isn’t signed in to Lovable. Connect it on the SEO page (Setup card), then press Publish it again.' }
  const now = new Date()
  // Their domain, if it's ready now, is connected as soon as the site is live (the question said so).
  const d = await clientDomain(r.clientId)
  const domain = d.choice && 'name' in d.choice ? d.choice.name : null
  const claimed = await prisma.hlSiteRequest.updateMany({
    where: { id: r.id, status: { in: SITE_PUBLISHABLE } },
    data: { status: 'publishing', stepAt: now, leaseUntil: null, liveUrl: null, publishedAt: null, detail: null, ...DOMAIN_RESET, domain, domainStep: domain ? 'queued' : null },
  })
  if (!claimed.count) return { ok: false, reason: 'Someone else just answered it.' }
  await note(r.id, `${by} answered Publish it${domain ? `, then connect ${domain}` : ''}.`)
  void advanceSiteBuild(r.id).catch((err) => console.error(`[hl-site] publish ${r.id}:`, err))
  return { ok: true, status: 'publishing', detail: `Publishing${domain ? `, then connecting ${domain}` : ''}. Forge says when it’s live, usually within a few minutes.` }
}

/** Clears a domain connection's working fields (a new try starts from Lovable's chat). */
const DOMAIN_RESET = { domainMessageId: null, domainThreadId: null, domainTxt: null, domainWwwTxt: null, domainStepAt: null, domainAt: null }

/** The client's domain as Forge would connect it now (./site-plan.ts siteDomainChoice), and its row in Hell-level → Domains. */
async function clientDomain(clientId: string): Promise<{ choice: SiteDomainChoice; accountId: string | null; domainId: string | null }> {
  const account = await prisma.hlAccount.findUnique({
    where: { clientId },
    select: { id: true, archivedAt: true, domains: { orderBy: { createdAt: 'asc' }, select: { id: true, name: true, origin: true, status: true } } },
  })
  if (!account || account.archivedAt) return { choice: null, accountId: null, domainId: null }
  const choice = siteDomainChoice(account.domains)
  const domainId = choice && 'name' in choice ? (account.domains.find((x) => x.name === choice.name)?.id ?? null) : null
  return { choice, accountId: account.id, domainId }
}

/** Forge's third question, once the site is live: connect their domain to it, or Not now. */
async function decideConnect(r: { id: string; clientId: string; status: string; projectId: string | null }, decision: 'connect' | 'no', by: string): Promise<SiteDecision> {
  if (r.status === 'connecting') return { ok: false, reason: 'Their domain is already being connected.' }
  if (r.status === 'connected') return { ok: false, reason: 'Their domain is already connected.' }
  if (r.status !== 'published') return { ok: false, reason: 'Their site has to be published first.' }
  if (decision === 'no') {
    const held = await prisma.hlSiteRequest.updateMany({ where: { id: r.id, status: 'published', OR: [{ domainStep: null }, { domainStep: 'queued' }] }, data: { domainStep: 'held' } })
    if (!held.count) return { ok: false, reason: 'That question was already answered.' }
    await note(r.id, `${by} answered Not now to connecting their domain.`)
    return { ok: true, status: 'published', detail: 'Not connected. Connect it from their folder in Sites when it’s ready.' }
  }
  if (!r.projectId) return { ok: false, reason: 'The Hub lost track of the Lovable copy. Connect the domain in Lovable instead.' }
  const d = await clientDomain(r.clientId)
  if (!d.choice) return { ok: false, reason: 'They have no domain yet. Buy one with Forge’s domain question, or add theirs in Hell-level → Domains.' }
  if ('waiting' in d.choice) return { ok: false, reason: `${d.choice.waiting} is still moving in. Connect it once that’s done.` }
  const row = await prisma.hlSiteRequest.findUnique({ where: { id: r.id }, select: { editorUrl: true, client: { select: { name: true } } } })
  const help = connectHelp(d.choice.name, d.choice.managed)
  const now = new Date()
  const claimed = await prisma.hlSiteRequest.updateMany({
    where: { id: r.id, status: 'published' },
    data: { status: 'connecting', leaseUntil: null, ...DOMAIN_RESET, domain: d.choice.name, domainStep: 'records', domainStepAt: now, detail: help },
  })
  if (!claimed.count) return { ok: false, reason: 'Someone else just answered it.' }
  await note(r.id, `${by} answered Connect it (${d.choice.name}).`)
  await textSiteEvent({ key: `${r.id}:${d.choice.name}:code:${now.getTime()}`, kind: 'connect_help', client: row?.client.name ?? 'a client', reason: help, link: hubLink(`/sites/${r.clientId}?builder=1`) })
  return { ok: true, status: 'connecting', detail: help }
}

/**
 * What a person does, said the same way in the Office, the text and their folder. Lovable's builder
 * can't be shown inside the Hub, so the folder's builder window opens it beside the Hub at Domains.
 */
function connectHelp(domain: string, managed: boolean): string {
  return `In their Sites folder, press Open website in builder: Lovable opens beside it at Settings → Domains. There, Connect domain → ${domain} → Connect a different way → Set up manually, copy the code that starts with lovable_verify= and press Done. Paste it in the Hub’s window, ${managed ? 'and the Hub sets the DNS at Porkbun and finishes.' : 'then add the DNS records Forge lists where the domain’s DNS is managed.'}`
}

/**
 * A person pasted what Lovable showed for the domain (its lovable_verify=
 * code, or both codes): a domain held here gets its DNS set at Porkbun and
 * Forge waits for it to show the site; one elsewhere gets the records to add
 * listed. The same as Connect the Lovable site on the domain's page.
 */
export async function pasteDomainCode(clientId: string, text: string, by: string): Promise<SiteDecision> {
  const r = await prisma.hlSiteRequest.findUnique({ where: { clientId }, select: { id: true, status: true, domain: true, domainStep: true } })
  if (!r || r.status !== 'connecting' || !r.domain) return { ok: false, reason: 'Forge isn’t connecting a domain for them right now.' }
  if (r.domainStep === 'live') return { ok: false, reason: `${r.domain}’s DNS is already set. Forge is waiting for it to show the site.` }
  const { rootTxt, wwwTxt } = lovableVerifyCodes(text)
  if (!rootTxt) return { ok: false, reason: 'Paste the value Lovable shows that starts with lovable_verify=.' }
  const d = await clientDomain(clientId)
  if (!d.choice || !('name' in d.choice) || d.choice.name !== r.domain || !d.domainId || !d.accountId) return { ok: false, reason: `${r.domain} isn’t ready in their Hell-level Domains.` }
  const records = recordsText(r.domain, rootTxt, wwwTxt)
  if (d.choice.managed) {
    await connectLovable(d.domainId, { host: '', rootTxt, wwwTxt, by })
    const detail = `${r.domain}’s DNS is set at Porkbun. Waiting for Lovable to finish (its certificate can take a few hours); if Lovable shows Check again, press it.`
    await note(r.id, `${by} pasted Lovable’s code; set ${r.domain}’s DNS at Porkbun (${records}).`, { domainStep: 'live', domainStepAt: new Date(), domainTxt: rootTxt, domainWwwTxt: wwwTxt, detail })
    return { ok: true, status: 'connecting', detail: `Set ${r.domain}’s DNS at Porkbun. Forge says when it shows the site.` }
  }
  await connectDomain({ accountId: d.accountId, name: r.domain, txt: rootTxt, wwwTxt, by })
  const detail = `Add these DNS records for ${r.domain} where its DNS is managed: ${records}. Forge checks every few minutes and carries on once they’re in.`
  await note(r.id, `${by} pasted Lovable’s code for ${r.domain}.`, { domainStep: 'records', domainStepAt: new Date(), domainTxt: rootTxt, domainWwwTxt: wwwTxt, detail })
  return { ok: true, status: 'connecting', detail }
}

/**
 * The one-shot as it would be sent, without copying or sending anything
 * (admin, by hand: one Claude call). For checking a client's prompt first.
 */
export async function previewClientSite(clientId: string): Promise<{ prompt: string; fill: SiteFill; shown: number[]; costUsd: number; note: string | null; facts: SiteFacts }> {
  const g = await gatherSite(clientId)
  if (!g) throw new SiteStop('No Hell-level sub-account for this client.')
  if (g.missing.length || !g.embeds) throw new SiteStop(`Can’t fill it: no ${g.missing.join(' or ')} on file.`)
  const res = await fillOneShot(g.facts)
  try {
    return { prompt: buildOneShot(g.facts, res.fill, g.embeds, { shown: res.shown }), fill: res.fill, shown: res.shown, costUsd: res.costUsd, note: res.note, facts: g.facts }
  } catch (err) {
    const notes = res.fill.notes.length ? ` Claude’s notes: ${res.fill.notes.join(' ')}` : ''
    throw new SiteStop(`${describe(err)} ($${res.costUsd.toFixed(2)} of Claude spent.)${notes}`)
  }
}

// ---------------------------------------------------------------------------
// The build: one step at a time
// ---------------------------------------------------------------------------

/** Run the build's steps until one has to wait (Lovable building) or it stops. */
export async function advanceSiteBuild(id: string): Promise<void> {
  for (let i = 0; i < 4; i++) {
    if (!(await runStep(id))) return
  }
}

const tries = new Map<string, number>()

/** One step under the row's lease. True when the next step can run straight away. */
async function runStep(id: string): Promise<boolean> {
  const now = new Date()
  const claimed = await prisma.hlSiteRequest.updateMany({
    where: { id, status: { in: SITE_WORKING }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
    data: { leaseUntil: new Date(now.getTime() + LEASE_MS) },
  })
  if (!claimed.count) return false
  const r = await prisma.hlSiteRequest.findUnique({ where: { id }, include: { client: { select: { name: true } } } })
  if (!r) return false
  const key = `${id}:${r.status}`
  try {
    let next = false
    if (r.status === 'filling') next = await fillStep(r)
    else if (r.status === 'copying') next = await copyStep(r)
    else if (r.status === 'sending') next = await sendStep(r)
    else if (r.status === 'publishing') next = await publishStep(r)
    else if (r.status === 'connecting') next = await connectStep(r)
    else await checkStep(r)
    tries.delete(key)
    return next
  } catch (err) {
    if (err instanceof Superseded) return false
    const n = (tries.get(key) ?? 0) + 1
    tries.set(key, n)
    // Claude declining, cutting off or refusing the request won't change on a retry, and each fill costs money: at most two.
    const claudeStop = err instanceof RefusalError || err instanceof TruncatedError || err instanceof FatalClaudeError
    const stop = err instanceof SiteStop || claudeStop || (err instanceof LovableMcpError && err.reconnect) || n >= (r.status === 'filling' ? 2 : MAX_TRIES)
    if (stop) {
      tries.delete(key)
      const why = stopReason(err, r.status)
      if (r.status === 'publishing') {
        // The site is still built: back to Forge's question, with what went wrong, for a person to try again.
        const back = await move(r.id, r.status, `Publishing stopped: ${why}`, { status: 'built', detail: `Publishing didn’t finish: ${why}` }).then(() => true, () => false)
        if (back) await textSiteEvent({ key: `${r.id}:${(r.stepAt ?? r.updatedAt).getTime()}`, kind: 'publish_failed', client: r.client.name, reason: why, link: r.editorUrl ?? sitesFolder(r.clientId) })
        return false
      }
      if (r.status === 'connecting') {
        // The site is still live on its lovable.app address: back to Forge's question, with what went wrong.
        const back = await move(r.id, r.status, `Connecting ${r.domain ?? 'their domain'} stopped: ${why}`, {
          status: 'published',
          domainStep: null,
          detail: `Connecting ${r.domain ?? 'their domain'} didn’t finish: ${why}`,
        }).then(
          () => true,
          () => false,
        )
        if (back) await textSiteEvent({ key: `${r.id}:${(r.domainStepAt ?? r.updatedAt).getTime()}`, kind: 'connect_failed', client: r.client.name, reason: why, link: r.editorUrl ?? sitesFolder(r.clientId) })
        return false
      }
      const failed = await move(r.id, r.status, `Stopped while ${r.status}: ${why}`, { status: 'failed', detail: why, finishedAt: new Date() }).then(() => true, () => false)
      if (failed) await textSiteEvent({ key: r.id, kind: 'failed', client: r.client.name, reason: why, link: r.editorUrl ?? sitesFolder(r.clientId) })
    } else {
      // Lovable or Claude didn't answer: the scheduler tries this step again in a minute.
      await note(r.id, `Try ${n} of ${MAX_TRIES} while ${r.status} didn’t go through: ${describe(err).slice(0, 300)}`, { detail: `Trying again: ${describe(err).slice(0, 200)}` })
    }
    return false
  } finally {
    await prisma.hlSiteRequest.updateMany({ where: { id }, data: { leaseUntil: null } })
  }
}

function stopReason(err: unknown, status: string): string {
  if (err instanceof LovableMcpError && err.reconnect) {
    const again = status === 'publishing' ? 'press Publish it again in the Office' : status === 'connecting' ? 'press Connect it again in the Office' : 'ask again from their folder in Sites'
    return `${err.message} (SEO page → Setup card), then ${again}.`
  }
  if (err instanceof RefusalError) return `Claude declined to fill the one-shot (${err.message}).`
  if (err instanceof TruncatedError) return 'Claude’s one-shot came back cut off.'
  if (err instanceof BudgetExceededError) return err.message
  if (err instanceof FatalClaudeError) return `Claude couldn’t fill the one-shot: ${err.message}`
  return describe(err)
}

/** filling → copying: Claude fills the one-shot. */
async function fillStep(r: SiteRow): Promise<boolean> {
  const g = await gatherSite(r.clientId)
  if (!g) throw new SiteStop('The client or their Hell-level sub-account is gone.')
  if (g.missing.length || !g.embeds) throw new SiteStop(`No ${g.missing.join(' or ')} on file. Add it in their Hell-level sub-account, then ask again from their folder in Sites.`)
  const res = await fillOneShot(g.facts)
  let prompt: string
  try {
    prompt = buildOneShot(g.facts, res.fill, g.embeds, { shown: res.shown })
  } catch (err) {
    // The answers don't hold what the site needs: asking Claude again wouldn't change that.
    const notes = res.fill.notes.length ? ` Claude’s notes: ${res.fill.notes.join(' ')}` : ''
    throw new SiteStop(`${describe(err)} Add it to their Hell-level Business Profile (Business address with city, state and ZIP; Service area) or onboarding answers, then ask again from their folder in Sites.${notes}`)
  }
  const kept = prompt.match(/^- https:\/\/\S+/gm)?.length ?? 0
  await move(r.id, 'filling', `Claude filled the one-shot for $${res.costUsd.toFixed(2)}: ${kept} of ${g.facts.photos.length} photo(s) kept.${res.note ? ` ${res.note}` : ''}`, {
    status: 'copying',
    stepAt: new Date(),
    prompt,
    projectName: projectNameFor(g.facts.ownerName, g.facts.businessName),
    fill: { ...res.fill, shown: res.shown, costUsd: res.costUsd, note: res.note, skipped: g.facts.skipped } as unknown as Prisma.InputJsonValue,
    detail: res.fill.notes.length ? `Claude’s notes: ${res.fill.notes.join(' ')}` : null,
  })
  return true
}

/** The copy the Hub asked Lovable for: in the workspace, by its exact name, made since the copy started. */
async function findCopy(workspaceId: string, name: string, sinceMs: number, template: string): Promise<LovableProjectRef | null> {
  const want = name.trim().toLowerCase()
  const found = (await lovableMcpFindProjects(workspaceId, name)).filter(
    (p) => p.id !== template && (p.name ?? '').trim().toLowerCase() === want && !!p.createdAt && Date.parse(p.createdAt) >= sinceMs,
  )
  return found.sort((a, b) => Date.parse(b.createdAt!) - Date.parse(a.createdAt!))[0] ?? null
}

async function adoptCopy(r: SiteRow, p: LovableProjectRef, template: string, how: string): Promise<boolean> {
  if (p.id === template) throw new SiteStop('Lovable answered with the template project itself, so nothing was sent.')
  await move(r.id, 'copying', `${how} “${r.projectName}” in Lovable: ${p.editorUrl ?? p.id}`, { status: 'sending', stepAt: new Date(), projectId: p.id, editorUrl: p.editorUrl, previewUrl: p.previewUrl })
  // The client's SEO seat gets the project: its links open it, and the daily Lovable → GitHub watch links the repo once GitHub is connected.
  await prisma.seoSite.updateMany({ where: { clientId: r.clientId, archivedAt: null, lovableProjectId: null }, data: { lovableProjectId: p.id } }).catch(() => undefined)
  return true
}

/** copying → sending: the template copied into its workspace. Never copies twice. */
async function copyStep(r: SiteRow): Promise<boolean> {
  const template = r.templateId ?? templateProject()
  const name = r.projectName ?? 'New client site'
  const since = (r.stepAt ?? r.updatedAt).getTime() - 5 * 60_000
  if (r.templateId && r.workspaceId) {
    // A copy was asked for already (a restart, or Lovable still copying): look for it, never copy again.
    const found = await findCopy(r.workspaceId, name, since, template)
    if (found) return adoptCopy(r, found, template, 'Found the copy')
    if (Date.now() - (r.stepAt ?? r.updatedAt).getTime() > COPY_GIVE_UP_MS) {
      throw new SiteStop(`Lovable never showed the copy of the template. Check Lovable for a project named “${name}” before asking again.`)
    }
    return false
  }
  const t = await lovableMcpProjectRef(template)
  if (!t) throw new SiteStop(`The Hub’s Lovable sign-in can’t see the template project (${template}).`)
  if (!t.workspaceId) throw new SiteStop('Lovable didn’t say which workspace the template project is in.')
  // Recorded before asking, so a restart mid-copy looks for the copy instead of making a second one.
  await note(r.id, `Copying the template (${t.name ?? template}) in Lovable as “${name}”.`, { templateId: template, workspaceId: t.workspaceId, stepAt: new Date() })
  let res: Awaited<ReturnType<typeof lovableMcpRemix>>
  try {
    res = await lovableMcpRemix({ projectId: template, workspaceId: t.workspaceId, name, timeoutSeconds: REMIX_WAIT_S })
  } catch (err) {
    // Refused outright (a missing permission, a plan limit): no copy is coming, so say so now.
    if (err instanceof LovableMcpError && /scope|\b403\b|refused|permission|forbidden|not allowed|upgrade|plan/i.test(err.message)) {
      throw new SiteStop(`Lovable refused to copy the template: ${err.message}`)
    }
    // No answer: the copy may still appear. The next checks look for it by name.
    throw err
  }
  const copy = res.project ?? (await findCopy(t.workspaceId, name, since, template))
  if (copy) return adoptCopy(r, copy, template, 'Copied the template as')
  if (res.status === 'error' && !/time(d)? ?out|timeout/i.test(res.error ?? '')) {
    throw new SiteStop(`Lovable couldn’t copy the template: ${res.error ?? 'no reason given'}. Check Lovable for a project named “${name}” before asking again.`)
  }
  // Still copying on Lovable's side (or its answer didn't name the copy): the next checks look for it by name.
  await note(r.id, res.status === 'completed' ? 'Lovable copied the template; looking the copy up by name.' : `Lovable is still copying (${res.error ?? res.status}).`)
  return false
}

/** The one-shot already in the copy's chat (sent before a restart, or a send that timed out but arrived). */
async function findSent(projectId: string, prompt: string, sinceMs?: number): Promise<string | null> {
  const head = prompt.slice(0, 200)
  const recent = await lovableMcpRecentMessages(projectId, 5)
  // With sinceMs, only a message sent since then counts (an earlier try's same words don't).
  const recentEnough = (createdAt: string | null) => sinceMs === undefined || (!!createdAt && Date.parse(createdAt) >= sinceMs)
  return recent.find((m) => m.role === 'user' && m.content.trim().startsWith(head.trim()) && recentEnough(m.createdAt))?.id ?? null
}

/** sending → building: the one-shot goes to the copy. Never twice (each send uses credits). */
async function sendStep(r: SiteRow): Promise<boolean> {
  const template = r.templateId ?? templateProject()
  if (!r.projectId || !r.prompt) throw new SiteStop('Nothing to send: no copy or no one-shot.')
  if (r.projectId === template || r.projectId === DEFAULT_TEMPLATE_PROJECT) throw new SiteStop('Refused to send the one-shot to the template project itself.')
  const building = { status: 'building', stepAt: new Date() }
  const before = await findSent(r.projectId, r.prompt)
  if (before) {
    await move(r.id, 'sending', 'The one-shot was already in Lovable’s chat (sent before a restart). Lovable is building the site.', { ...building, messageId: before, threadId: r.threadId ?? 'main' })
    return false
  }
  let sent: Awaited<ReturnType<typeof lovableMcpSend>>
  try {
    sent = await lovableMcpSend(r.projectId, r.prompt)
  } catch (err) {
    // A send that timed out may still have arrived: look before trying again.
    const arrived = await findSent(r.projectId, r.prompt).catch(() => null)
    if (!arrived) throw err
    sent = { messageId: arrived, threadId: 'main', status: null }
  }
  await move(r.id, 'sending', 'Sent the one-shot to Lovable. Lovable is building the site.', { ...building, messageId: sent.messageId, threadId: sent.threadId })
  return false
}

/** building (or waiting on a person in Lovable) → built, failed, or still going. */
async function checkStep(r: SiteRow): Promise<void> {
  if (!r.projectId || !r.messageId) throw new SiteStop('Lost track of the message sent to Lovable.')
  const s = await lovableMcpAgentState(r.projectId, r.messageId, r.threadId)
  const link = r.editorUrl ?? `https://lovable.dev/projects/${r.projectId}`
  if (s.state === 'done') {
    const credits = s.credits !== null ? ` using ${s.credits} Lovable credits` : ''
    await move(r.id, r.status, `Lovable finished building the site${credits}.`, {
      status: 'built',
      finishedAt: new Date(),
      previewUrl: s.previewUrl ?? r.previewUrl,
      detail: `Built${credits}. Look it over in Lovable, then answer Forge’s question in the Office: publish it?`,
      pause: Prisma.DbNull,
    })
    await textSiteEvent({ key: r.id, kind: 'built', client: r.client.name, link })
    return
  }
  if (s.state === 'waiting') {
    await onPause(r, pauseFrom(s), r.messageId, link)
    return
  }
  if (s.state === 'stopped' || s.state === 'error') {
    throw new SiteStop(`Lovable ${s.state === 'stopped' ? 'stopped' : 'hit an error'} before the site was done${s.note ? `: ${s.note.slice(0, 300)}` : ''}. Look at it in Lovable.`)
  }
  // Queued behind an earlier turn that's paused for a person: usually Lovable's own message after the copy.
  if (s.queue?.paused && (await clearQueue(r, link))) return
  // Still working.
  if (r.status === 'waiting_on_lovable') await move(r.id, r.status, 'Lovable carried on building.', { status: 'building', detail: null, pause: Prisma.DbNull })
  else if (Date.now() - (r.stepAt ?? r.updatedAt).getTime() > BUILD_SLOW_MS && !r.detail?.startsWith('Still building')) {
    await note(r.id, 'Still building after 4 hours.', { detail: 'Still building after 4 hours: have a look in Lovable.' })
  }
}

/** The start of every log line for an answer Forge gave Lovable itself (counted against MAX_FORGE_ANSWERS). */
const FORGE_ANSWERED = 'Forge answered Lovable:'

const pauseFrom = (s: LovableAgentState): SitePause => readPause(s.awaitingRaw ?? null, s.reply ?? null, new Date())
const clipText = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * Forge's one-shot sits queued behind a paused turn. Lovable's own message after
 * the copy ("What would be a good next step?") isn't part of the build: Forge
 * declines its question, and the brief runs. Anything else holding it up goes to
 * a person. False when no paused turn turns up (it may have cleared meanwhile).
 */
async function clearQueue(r: SiteRow, link: string): Promise<boolean> {
  const recent = await lovableMcpRecentMessages(r.projectId!, 10)
  // A queued message isn't in Lovable's list: the build step started when it was sent.
  const sentAt = recent.find((m) => m.id === r.messageId)?.createdAt ?? (r.stepAt ?? r.updatedAt).toISOString()
  const answered = ((r.log as LogEntry[] | null) ?? []).filter((e) => e.what.startsWith(FORGE_ANSWERED)).length
  for (const m of recent) {
    if (m.role !== 'user' || m.id === r.messageId) continue
    const st = await lovableMcpAgentState(r.projectId!, m.id, r.threadId)
    if (st.state !== 'waiting') continue
    const pause = pauseFrom(st)
    if (pause.eventId && pause.kind !== 'editor' && answered < MAX_FORGE_ANSWERS && isCopyChatTurn(m, { id: r.messageId!, createdAt: sentAt })) {
      const res = await lovableMcpRespond({
        projectId: r.projectId!,
        messageId: m.id,
        threadId: r.threadId,
        eventId: pause.eventId,
        decision: 'rejected',
        userInput: 'Not now, thanks. The next message is this copy’s brief.',
      })
      await note(
        r.id,
        `${FORGE_ANSWERED} Lovable’s own message after the copy (“${clipText(m.content.trim(), 90)}”) had stopped on a question (“${pauseSummary(pause)}”), holding up the brief. Forge declined it, so the brief runs now.${res.alreadyAnswered ? ' Someone had already answered it.' : ''}`,
      )
      return true
    }
    await onPause(r, pause, m.id, link, 'An earlier message in this copy is paused, and Lovable holds the brief until it’s answered.')
    return true
  }
  return false
}

/**
 * Lovable stopped for a person (src/lib/hl/site-pause.ts). Forge answers from
 * the brief when it may; otherwise a person does, with Forge's suggestion: in
 * the client's Sites folder when the Hub can pass the answer on, else in
 * Lovable's editor.
 */
async function onPause(r: SiteRow, pause: SitePause, on: string, link: string, context?: string): Promise<void> {
  pause.on = on
  const saved = readSavedPause(r.pause)
  // Already with a person: nothing new to do.
  if (r.status === 'waiting_on_lovable' && saved && saved.on === on && saved.eventId === pause.eventId) return
  const answered = ((r.log as LogEntry[] | null) ?? []).filter((e) => e.what.startsWith(FORGE_ANSWERED)).length
  if (forgeMayAnswer(pause) && r.prompt && answered < MAX_FORGE_ANSWERS) {
    try {
      const { read, costUsd } = await readPauseAgainstBrief(r.prompt, pause)
      pause.forge = read
      const resp = forgeResponse(pause, read)
      if (resp) {
        await lovableMcpRespond({
          projectId: r.projectId!,
          messageId: on,
          threadId: r.threadId,
          eventId: pause.eventId!,
          decision: resp.decision,
          userInput: resp.decision === 'approved' ? resp.userInput : resp.reason,
        })
        const cost = ` (Claude read it for $${costUsd.toFixed(2)}.)`
        await note(
          r.id,
          resp.decision === 'approved'
            ? `${FORGE_ANSWERED} it asked “${pauseSummary(pause)}”, and Forge answered “${answerWords(pause, resp.userInput)}”, as the brief says: “${clipText(read.briefLine, 200)}”.${cost}`
            : `${FORGE_ANSWERED} it finished the brief and offered more (“${pauseSummary(pause)}”), and Forge said no, that’s all.${cost}`,
          r.status === 'waiting_on_lovable' ? { status: 'building', detail: null, pause: Prisma.DbNull } : {},
        )
        return
      }
    } catch (err) {
      pause.forge = null
      console.warn('[hl-site] reading a Lovable pause:', describe(err))
    }
  }
  const inHub = pause.kind !== 'editor' && !!pause.eventId
  const what = pauseSummary(pause)
  const suggests = pause.kind === 'questions' && pause.forge && Object.keys(pause.forge.answers).length ? ` Forge suggests: ${answerWords(pause, pause.forge.answers)}.` : ''
  const where = inHub ? 'Answer it in their Sites folder' : 'Answer it in Lovable’s editor'
  await move(r.id, r.status, `Lovable stopped for a person: ${what}`, {
    status: 'waiting_on_lovable',
    detail: `${context ? `${context} ` : ''}Lovable is asking: ${what}${suggests} ${where}; Forge carries on after.`,
    pause: pause as unknown as Prisma.InputJsonValue,
  })
  await textSiteEvent({
    key: `${r.id}:${pause.eventId ?? on}`,
    kind: inHub ? 'question' : 'lovable',
    client: r.client.name,
    reason: `${what}${suggests}`,
    link: inHub ? hubLink(`/sites/${r.clientId}`) : link,
  })
}

/**
 * A person's answer to what Lovable paused on, from the client's Sites folder:
 * passed on to Lovable as theirs. `decision`: answer (with `answers` per
 * question key) | skip, for questions; approve | decline, for a tool.
 */
export async function answerSitePause(
  clientId: string,
  by: string,
  body: { eventId?: unknown; decision?: unknown; answers?: unknown },
): Promise<{ ok: true; detail: string } | { ok: false; reason: string }> {
  const r = await prisma.hlSiteRequest.findUnique({ where: { clientId } })
  if (!r || r.status !== 'waiting_on_lovable' || !r.projectId) return { ok: false, reason: 'Lovable isn’t waiting on a question for this build.' }
  const pause = readSavedPause(r.pause)
  if (!pause?.eventId || pause.eventId !== body.eventId) return { ok: false, reason: 'That question has changed. Reload the folder.' }
  const decision = body.decision === 'answer' || body.decision === 'skip' || body.decision === 'approve' || body.decision === 'decline' ? body.decision : null
  if (!decision) return { ok: false, reason: 'Say answer, skip, approve or decline.' }
  const answers = body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers) ? (body.answers as Record<string, unknown>) : undefined
  const resp = personResponse(pause, { decision, answers })
  if (!resp) return { ok: false, reason: pause.kind === 'questions' ? 'Pick an answer for each question, or Skip.' : 'That doesn’t fit what Lovable asked.' }
  let already = false
  try {
    const res = await lovableMcpRespond({
      projectId: r.projectId,
      messageId: pause.on ?? r.messageId!,
      threadId: r.threadId,
      eventId: pause.eventId,
      decision: resp.decision,
      userInput: resp.decision === 'approved' ? resp.userInput : resp.reason,
    })
    already = res.alreadyAnswered
  } catch (err) {
    return { ok: false, reason: `Lovable didn’t take the answer: ${describe(err).slice(0, 200)}` }
  }
  const did = resp.decision === 'approved' ? (resp.userInput ? `answered “${answerWords(pause, resp.userInput)}”` : 'approved it') : pause.kind === 'questions' ? 'skipped it' : 'declined it'
  await move(r.id, 'waiting_on_lovable', `${by} ${did} (Lovable asked: ${pauseSummary(pause)}).${already ? ' It had already been answered.' : ''}`, { status: 'building', detail: null, pause: Prisma.DbNull }).catch(() => {})
  return { ok: true, detail: 'Sent to Lovable. Forge carries on with the build.' }
}

/** Where an address ends up when it loads (Lovable sends a site with a domain on to it), or null. */
async function loads(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; GenisysHub/1.0)' } })
    await res.body?.cancel().catch(() => undefined)
    return res.ok ? res.url || url : null
  } catch {
    return null
  }
}

/** Lovable answering that it won't (a name it won't take, security findings, a plan limit), as opposed to no answer at all. */
const lovableSaidNo = (err: unknown) => err instanceof LovableMcpError && !err.reconnect && /^deploy_project failed|refused/i.test(err.message)

/**
 * publishing → published: the Hub's Lovable sign-in publishes the copy at
 * <business-name>.lovable.app (free), then every minute checks the address
 * until it loads, and that its /privacy and /terms do (the form links them).
 */
async function publishStep(r: SiteRow): Promise<boolean> {
  const template = r.templateId ?? templateProject()
  if (!r.projectId) throw new SiteStop('The Hub lost track of the Lovable copy. Publish it in Lovable instead.')
  if (r.projectId === template || r.projectId === DEFAULT_TEMPLATE_PROJECT) throw new SiteStop('Refused to publish the template project itself.')
  if (!r.liveUrl) {
    const fill = (r.fill ?? {}) as Partial<SiteFill>
    const named = publishSlug(fill.displayName || fill.legalName || r.client.name)
    // An address that already loads is another site's (a copy is never published before this): Lovable picks one instead.
    const slug = named && !(await loads(`https://${named}.lovable.app`)) ? named : null
    if (named && !slug) await note(r.id, `${named}.lovable.app is taken. Letting Lovable pick the address.`)
    let dep: Awaited<ReturnType<typeof lovableMcpDeploy>>
    try {
      dep = await lovableMcpDeploy(r.projectId, slug ?? undefined)
    } catch (err) {
      if (!lovableSaidNo(err)) throw err
      if (!slug) throw new SiteStop(`Lovable wouldn’t publish it: ${describe(err)}`)
      // Most likely the name is someone else's: Lovable picks an address instead.
      await note(r.id, `Lovable wouldn’t publish it as ${slug}.lovable.app (${describe(err).slice(0, 200)}). Letting Lovable pick the address.`)
      try {
        dep = await lovableMcpDeploy(r.projectId)
      } catch (again) {
        throw lovableSaidNo(again) ? new SiteStop(`Lovable wouldn’t publish it: ${describe(again)}`) : again
      }
    }
    const url = dep.url ?? (slug ? `https://${slug}.lovable.app` : null)
    if (!url) throw new SiteStop(`Lovable didn’t say where it published the site (${dep.detail || 'no answer'}). Look in Lovable.`)
    await move(r.id, 'publishing', `Asked Lovable to publish it at ${url}.`, { liveUrl: url })
    return false
  }
  const served = await loads(r.liveUrl)
  if (!served) {
    if (Date.now() - (r.stepAt ?? r.updatedAt).getTime() > PUBLISH_GIVE_UP_MS) {
      throw new SiteStop(`Lovable was asked to publish it, but ${r.liveUrl} still doesn’t load after 30 minutes. Look in Lovable (its Publish button).`)
    }
    return false
  }
  const live = new URL(served).origin
  const missing = (await Promise.all([BUILT_SITE_PAGES.privacy, BUILT_SITE_PAGES.terms].map(async (p) => ((await loads(`${live}${p}`)) ? null : p)))).filter(
    (p): p is (typeof BUILT_SITE_PAGES)[keyof typeof BUILT_SITE_PAGES] => !!p,
  )
  const pagesNote = missing.length ? ` Its ${missing.join(' and ')} page${missing.length > 1 ? 's' : ''} didn’t load, and the form and chat link them: look in Lovable.` : ''
  // The domain they had when Publish it was pressed is connected straight away (that Yes covered it).
  const domainNext = r.domainStep === 'queued' && r.domain
  const now = new Date()
  const help = domainNext && r.domain ? connectHelp(r.domain, isManaged(await clientDomain(r.clientId))) : null
  await move(r.id, 'publishing', `Live at ${live}.${pagesNote}${domainNext ? ` Connecting ${r.domain} next.` : ''}`, {
    status: domainNext ? 'connecting' : 'published',
    liveUrl: live,
    publishedAt: now,
    ...(domainNext ? { domainStep: 'records', domainStepAt: now } : {}),
    detail: help ? `Live at ${live}.${pagesNote} Next: ${help}` : `Live at ${live}.${pagesNote}`,
  })
  await textSiteEvent({ key: `${r.id}:${live}`, kind: 'published', client: r.client.name, reason: domainNext ? `Next, to put it on ${r.domain}: ${help}` : '', link: live })
  return false
}

/** Whether the client's domain is held here (the Hub sets its DNS); true when it can't tell. */
function isManaged(d: Awaited<ReturnType<typeof clientDomain>>): boolean {
  return d.choice && 'name' in d.choice ? d.choice.managed : true
}

// ---------------------------------------------------------------------------
// Connecting their domain
// ---------------------------------------------------------------------------

/** A page as fetched: where it ended up (after redirects) and its <title>. Null when it doesn't load. */
async function page(url: string): Promise<{ url: string; title: string | null } | null> {
  try {
    const res = await fetch(url, { redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; GenisysHub/1.0)' } })
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      return null
    }
    const html = (await res.text()).slice(0, 200_000)
    const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim() || null
    return { url: res.url || url, title }
  } catch {
    return null
  }
}

/**
 * Whether the domain shows the site Forge published: it loads over https at
 * the domain (www or not), and Lovable now sends the lovable.app address
 * there, or both pages carry the same title.
 */
async function showsSite(domain: string, liveUrl: string | null): Promise<boolean> {
  const at = await page(`https://${domain}/`)
  if (!at || bareHost(at.url) !== domain) return false
  if (!liveUrl || bareHost(liveUrl) === domain) return true
  const published = await page(liveUrl)
  if (!published) return false
  return bareHost(published.url) === domain || (!!at.title && at.title === published.title)
}

/** The records a person adds at their DNS provider, as the Office and the text say them. */
function recordsText(domain: string, rootTxt: string | null, wwwTxt: string | null): string {
  return siteRecords({ host: '', txt: rootTxt, wwwTxt })
    .map((x) => `${x.type} ${x.host === '@' ? domain : `${x.host}.${domain}`} → ${x.value}`)
    .join(' · ')
}

/** connecting: one step at a time (see the top of this file). True when the next can run straight away. */
async function connectStep(r: SiteRow): Promise<boolean> {
  if (!r.domain) throw new SiteStop('Lost track of which domain to connect.')
  const d = await clientDomain(r.clientId)
  if (!d.choice || !('name' in d.choice) || d.choice.name !== r.domain) {
    throw new SiteStop(`${r.domain} isn’t ready in their Hell-level Domains any more${d.choice && 'waiting' in d.choice ? ` (${d.choice.waiting} is moving in)` : ''}.`)
  }
  // Rows from before the paste box (they asked Lovable's chat, which can't connect a domain) wait for the code too.
  if (r.domainStep === 'records' || r.domainStep === 'asking' || r.domainStep === 'lovable') return waitForRecords(r, r.domain, d.choice.managed, d.domainId)
  if (r.domainStep === 'live') return waitForLive(r, r.domain)
  throw new SiteStop('Lost track of where connecting the domain was.')
}

/** records → live: the records are in (a person added them elsewhere, or pasted Lovable's code here). */
async function waitForRecords(r: SiteRow, domain: string, managed: boolean, domainId: string | null): Promise<boolean> {
  if (!domainId) throw new SiteStop(`${domain} isn’t in their Hell-level Domains any more.`)
  const row = managed ? await prisma.hlDomain.findUnique({ where: { id: domainId }, select: { meta: true } }) : await verifyExternal(domainId)
  const root = metaOf(row?.meta).hosts?.find((h) => h.host === '')
  // Only a code set since Forge asked counts: an older connection's code wouldn't verify this one.
  const fresh = !!root?.txt && Date.parse(root.addedAt) >= (r.domainStepAt ?? r.updatedAt).getTime() - 5 * 60_000
  const ready = managed ? fresh : fresh && !!root?.lastCheck?.ok
  if (ready) {
    await move(r.id, 'connecting', managed ? `${domain}’s Lovable code was pasted and its DNS set here.` : `${domain}’s records are in its DNS.`, {
      domainStep: 'live',
      domainStepAt: new Date(),
      domainTxt: root?.txt ?? r.domainTxt,
      domainWwwTxt: root?.wwwTxt ?? r.domainWwwTxt,
      detail: `${domain}’s DNS is set. Waiting for Lovable to finish (its certificate can take a few hours).`,
    })
    return false
  }
  if (Date.now() - (r.domainStepAt ?? r.updatedAt).getTime() > RECORDS_GIVE_UP_MS) throw new SiteStop(`Lovable’s code for ${domain} (or its DNS records) still isn’t in after a week.`)
  return false
}

/** live → connected: the domain shows the site; it becomes their site link in Clients. */
async function waitForLive(r: SiteRow, domain: string): Promise<boolean> {
  if (await showsSite(domain, r.liveUrl)) {
    const url = `https://${domain}`
    await move(r.id, 'connecting', `${domain} shows the site. Saved as their site link in Clients.`, {
      status: 'connected',
      domainStep: null,
      domainAt: new Date(),
      detail: `Live at ${url}. Saved as their site link in Clients. Still by hand: connect GitHub in Lovable.`,
    })
    try {
      const saved = await saveSiteLink(r.clientId, url)
      if (saved.changed) await note(r.id, `Their site link in Clients is now ${url}${saved.prior ? ` (was ${saved.prior})` : ''}.`)
      // Already their link in Clients (typed in before the domain showed the site): what follows a new
      // link runs now that the site is really there: its policy pages, its logo, and their toll-free
      // number's texting verification, which waits for those pages.
      else afterSiteLinkChange(r.clientId, url, saved.prior)
    } catch (err) {
      await note(r.id, `Couldn’t save ${url} as their site link in Clients (${describe(err).slice(0, 200)}): save it there by hand.`, {
        detail: `Live at ${url}, but saving it as their site link in Clients failed: save it there by hand. Still by hand: connect GitHub in Lovable.`,
      })
    }
    await textSiteEvent({ key: `${r.id}:${domain}:live`, kind: 'connected', client: r.client.name, link: url })
    return false
  }
  const waited = Date.now() - (r.domainStepAt ?? r.updatedAt).getTime()
  if (waited > LIVE_GIVE_UP_MS) {
    throw new SiteStop(`${domain} still doesn’t show the site three days after its DNS was set. In Lovable open the site → Settings → Domains and press Check again; past that, Lovable’s support issues the certificate.`)
  }
  if (waited > LIVE_NUDGE_MS && !r.detail?.startsWith('Still waiting')) {
    await note(r.id, `${domain} doesn’t show the site after a day.`, { detail: `Still waiting for ${domain} after a day. In Lovable open the site → Settings → Domains and press Check again.` })
  }
  return false
}


// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let lastAskSweep = 0
const lastPoll = new Map<string, number>()

/**
 * Every minute: carry on builds (a step a restart cut off, and Lovable to
 * check on), and every 10 minutes ask about new sub-accounts the onboarding
 * hook missed.
 */
export async function maybeSweepSiteRequests(now = Date.now()): Promise<number> {
  let moved = 0
  const working = await prisma.hlSiteRequest.findMany({
    where: { status: { in: SITE_WORKING }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date(now) } }] },
    select: { id: true, status: true, domainStep: true },
    take: 20,
  })
  for (const w of working) {
    const watching = w.status === 'building' || w.status === 'waiting_on_lovable' || w.status === 'publishing' || w.status === 'connecting'
    // DNS and certificates change slowly: those waits are checked every few minutes.
    const every = w.status === 'connecting' && (w.domainStep === 'records' || w.domainStep === 'live') ? DOMAIN_POLL_MS : POLL_EVERY_MS
    if (watching && now - (lastPoll.get(w.id) ?? 0) < every - 5_000) continue
    lastPoll.set(w.id, now)
    // Not awaited: a fill or a copy takes minutes, and the lease keeps it to one runner.
    void advanceSiteBuild(w.id).catch((err) => console.error(`[hl-site] build ${w.id}:`, err))
    // A check on Lovable every minute isn't news; picking up a step a restart cut off is.
    if (!watching) moved += 1
  }
  if (now - lastAskSweep >= ASK_SWEEP_EVERY_MS) {
    lastAskSweep = now
    const since = await siteSince()
    const fresh = await prisma.client.findMany({
      where: { archivedAt: null, ghlLocationId: null, hlSiteRequest: { is: null }, hlAccount: { is: { createdAt: { gte: since }, archivedAt: null } } },
      select: { id: true },
      take: 10,
    })
    for (const c of fresh) {
      const res = await askForClientSite(c.id, 'sweep').catch(() => null)
      if (res?.ok) moved += 1
    }
  }
  return moved
}
