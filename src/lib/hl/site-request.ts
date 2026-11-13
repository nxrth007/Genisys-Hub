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
 * Then the site is built but not published: a person reviews it in Lovable,
 * publishes, connects the domain and GitHub there, and saves the live link in
 * Clients (which sets up the sub-account's website and texting verification).
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
  lovableMcpFindProjects,
  lovableMcpProjectRef,
  lovableMcpRecentMessages,
  lovableMcpRemix,
  lovableMcpSend,
  lovableMcpStatus,
  type LovableProjectRef,
} from '@/lib/seo/lovable-mcp'
import { readProfile, zoneFromAnswers } from './accounts'
import { REVIEW_REQUEST_FORM } from './client-kit'
import { fillOneShot } from './site-fill'
import {
  buildOneShot,
  cleanDomain,
  DEFAULT_TEMPLATE_PROJECT,
  gbpLinkFrom,
  phoneParts,
  pickPhotos,
  projectNameFor,
  siteAskDecision,
  siteQuestionDetail,
  SITE_WORKING,
  socialLinksFrom,
  zoneWord,
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
    email: emailOrBlank(i?.leadEmail) || emailOrBlank(p.notifyEmail?.split(',')[0]) || emailOrBlank(c.contactEmail),
    address,
    cities: answer(i?.cities),
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

  const missing = [!phone && 'phone number', !facts.email && 'email address', !embeds && 'Hell-level quote form and chat widget'].filter((x): x is string => !!x)
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
  const who = trigger === 'manual' ? `by hand${opts.by ? ` (${opts.by})` : ''}` : 'the client just onboarded'
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
    log: [{ at: new Date().toISOString(), what: `Asked in the Office (${who}).${earlier}` }] as unknown as Prisma.InputJsonValue,
  }
  const row = c.hlSiteRequest
    ? await prisma.hlSiteRequest.update({ where: { id: c.hlSiteRequest.id }, data, select: { id: true } })
    : await prisma.hlSiteRequest.create({ data: { clientId, ...data }, select: { id: true } })
  return { ok: true, status: 'awaiting_approval', id: row.id }
}

export type SiteDecision = { ok: true; status: string; detail: string | null } | { ok: false; reason: string }

/** A person's answer in the Office: Build it (fill, copy, send, watch) or Not now. */
export async function decideClientSite(id: string, decision: 'build' | 'no', by: string): Promise<SiteDecision> {
  const r = await prisma.hlSiteRequest.findUnique({ where: { id }, select: { id: true, status: true } })
  if (!r) return { ok: false, reason: 'That question is gone.' }
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
      const why = stopReason(err)
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

function stopReason(err: unknown): string {
  if (err instanceof LovableMcpError && err.reconnect) return `${err.message} (SEO page → Setup card), then ask again from their folder in Sites.`
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
    throw new SiteStop(`${describe(err)} Add it to their Hell-level Business Profile or onboarding answers, then ask again from their folder in Sites.${notes}`)
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
  // Still copying on Lovable's side: the next checks look for it by name.
  await note(r.id, `Lovable is still copying (${res.error ?? res.status}).`)
  return false
}

/** The one-shot already in the copy's chat (sent before a restart, or a send that timed out but arrived). */
async function findSent(projectId: string, prompt: string): Promise<string | null> {
  const head = prompt.slice(0, 200)
  const recent = await lovableMcpRecentMessages(projectId, 5)
  return recent.find((m) => m.role === 'user' && m.content.trim().startsWith(head.trim()))?.id ?? null
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
      detail: `Built${credits}. Review it in Lovable, then publish it, connect the domain and GitHub there, and save the live link in Clients.`,
    })
    await textSiteEvent({ key: r.id, kind: 'built', client: r.client.name, link })
    return
  }
  if (s.state === 'waiting') {
    if (r.status !== 'waiting_on_lovable') {
      await move(r.id, r.status, `Lovable is waiting for a person: ${s.note ?? 'a check-in in its editor'}`, { status: 'waiting_on_lovable', detail: `${s.note ?? 'Lovable paused for a person.'} Answer it in Lovable’s editor; Forge carries on after.` })
      await textSiteEvent({ key: `${r.id}:${r.messageId}`, kind: 'lovable', client: r.client.name, reason: s.note ?? '', link })
    }
    return
  }
  if (s.state === 'stopped' || s.state === 'error') {
    throw new SiteStop(`Lovable ${s.state === 'stopped' ? 'stopped' : 'hit an error'} before the site was done${s.note ? `: ${s.note.slice(0, 300)}` : ''}. Look at it in Lovable.`)
  }
  // Still working.
  if (r.status === 'waiting_on_lovable') await move(r.id, r.status, 'Lovable carried on building.', { status: 'building', detail: null })
  else if (Date.now() - (r.stepAt ?? r.updatedAt).getTime() > BUILD_SLOW_MS && !r.detail?.startsWith('Still building')) {
    await note(r.id, 'Still building after 4 hours.', { detail: 'Still building after 4 hours: have a look in Lovable.' })
  }
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
    select: { id: true, status: true },
    take: 20,
  })
  for (const w of working) {
    const watching = w.status === 'building' || w.status === 'waiting_on_lovable'
    if (watching && now - (lastPoll.get(w.id) ?? 0) < POLL_EVERY_MS - 5_000) continue
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
