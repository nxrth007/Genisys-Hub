/**
 * Office: the deterministic mapping from real Hub records to the virtual
 * office's bots, statuses and activity feed. Pure (no imports, no DB, no
 * clock) so it is unit-testable; src/lib/office/state.ts does the queries
 * and passes `now` in.
 *
 * One bot per pipeline role. The journey stages come from
 * src/lib/client-journey.ts (signup -> intake -> subaccount -> website ->
 * a2p -> qa); SEO runs, A2P filings, sub-account match suggestions, Whop
 * sign-up claims and the Render monitor state add their own signals.
 */

export const OFFICE_STATUSES = ['coding', 'browsing', 'terminal', 'thinking', 'needs_you', 'error', 'idle'] as const
export type OfficeStatus = (typeof OFFICE_STATUSES)[number]

export type BubbleIcon = 'code' | 'globe' | 'terminal' | 'dots' | 'alert' | 'error' | 'check' | 'folder' | 'gear' | null

export type BotId = 'alfred' | 'wren' | 'ivy' | 'atlas' | 'forge' | 'echo' | 'tally' | 'scout' | 'sentinel'

export type RosterEntry = { id: BotId; name: string; role: string; color: string; source: string }

/** Order matters: it is also the desk assignment order (see layout.ts). */
export const ROSTER: readonly RosterEntry[] = [
  { id: 'alfred', name: 'Alfred', role: 'Chief of Staff', color: '#f5c542', source: 'All journey events + every other bot' },
  { id: 'wren', name: 'Wren', role: 'Whop signup intake', color: '#38bdf8', source: 'Journey stage "signup", WhopSignupClaim' },
  { id: 'ivy', name: 'Ivy', role: 'Onboarding form', color: '#a78bfa', source: 'ClientIntake, journey stage "intake"' },
  { id: 'atlas', name: 'Atlas', role: 'CRM sub-accounts', color: '#34d399', source: 'Journey stage "subaccount", SubaccountMatchSuggestion, GhlSubaccountJob, GhlCustomizeJob' },
  { id: 'forge', name: 'Forge', role: 'Website build', color: '#fb923c', source: 'Journey stage "website", HlDomainRequest, HlSiteRequest' },
  { id: 'echo', name: 'Echo', role: 'A2P registration', color: '#f472b6', source: 'Journey stage "a2p", HlA2p, HlNumberRequest' },
  { id: 'tally', name: 'Tally', role: 'Tracker & QA', color: '#facc15', source: 'Journey stage "qa"' },
  { id: 'scout', name: 'Scout', role: 'SEO engine', color: '#22d3ee', source: 'SeoRun' },
  { id: 'sentinel', name: 'Sentinel', role: 'Render monitor', color: '#ef4444', source: 'AppSetting "render.monitor"' },
] as const

export const STAGE_BOT: Record<string, BotId> = {
  signup: 'wren',
  intake: 'ivy',
  subaccount: 'atlas',
  website: 'forge',
  a2p: 'echo',
  qa: 'tally',
}

/** What a bot "does" while a stage is in progress. */
const STAGE_WORK: Record<string, OfficeStatus> = {
  signup: 'browsing',
  intake: 'coding',
  subaccount: 'browsing',
  website: 'coding',
  a2p: 'terminal',
  qa: 'coding',
}

const STAGE_LABEL: Record<string, string> = {
  signup: 'Whop signup',
  intake: 'Onboarding form',
  subaccount: 'GHL sub-account',
  website: 'Website build',
  a2p: 'A2P registration',
  qa: 'Tracker / QA',
}

/** A recent event keeps a bot "working" this long. */
export const ACTIVE_MS = 20 * 60_000
/** A done event shows a checkmark this long. */
export const DONE_MS = 10 * 60_000
/** In-progress stage rows count as live work if touched this recently. */
export const STALE_MS = 24 * 60 * 60_000
/** Failed SEO runs stay red this long. */
export const ERROR_MS = 24 * 60 * 60_000
/** Handoffs this recent are animated. */
export const HANDOFF_MS = 30 * 60_000
/** A running sub-account job beats every 20 seconds; this much silence means it stalled. */
export const SUBACCOUNT_STALL_MS = 3 * 60_000
/** A queued sub-account job nobody has picked up for this long means the worker isn't taking jobs. */
export const SUBACCOUNT_WAIT_MS = 45 * 60_000
/** A sub-account job that needs a person, or failed, stays open this long. */
export const SUBACCOUNT_OPEN_MS = 14 * 24 * 60 * 60_000

// ---------- input (plain rows from state.ts) ----------

export type JourneyEventIn = {
  id: string
  clientId: string
  clientName: string
  stage: string
  fromStatus: string | null
  toStatus: string
  note: string | null
  actor: string | null
  createdAt: Date
}
export type StageRowIn = { clientId: string; clientName: string; stage: string; status: string; note: string | null; updatedAt: Date }
export type IntakeIn = { id: string; receivedAt: Date; status: string; name: string | null }
export type WhopClaimIn = { membershipId: string; source: string; claimedAt: Date }
export type MatchSuggestionIn = { id: string; clientName: string; locationName: string; score: number; status: string; createdAt: Date; updatedAt: Date }
export type SeoRunIn = {
  id: string
  siteName: string
  status: string
  stage: string
  error: string | null
  startedAt: Date | null
  finishedAt: Date | null
  createdAt: Date
  updatedAt: Date
}
export type A2pIn = { id: string; accountName: string; stage: string; note: string | null; updatedAt: Date }
export type RenderMonitorIn = { enabled: boolean; heartbeatFailures: number; openProblems: number; lastDigestAt: Date | null } | null
/**
 * One browser-worker job: a GhlSubaccountJob (creates a client's GHL
 * sub-account) or, with kind 'customize', a GhlCustomizeJob (puts their copy
 * into the GHL lead workflows with Workflow AI).
 */
export type SubaccountJobIn = {
  id: string
  clientId?: string
  clientName: string
  status: string
  detail: string | null
  updatedAt: Date
  heartbeatAt: Date | null
  nextAttemptAt: Date
  finishedAt: Date | null
  /** customize = the lead-workflow copy job; form = the site form made the client's own. */
  kind?: 'create' | 'customize' | 'form'
}
/**
 * A bot's question waiting for an answer in the Office: Echo asking where to
 * get a new client's toll-free number (kind number), or whether to send GHL's
 * toll-free registration it filled for a number in GHL (kind registration;
 * the id is then the GhlNumberJob's). ringTo is where its calls would ring
 * (E.164), when a phone is on file.
 */
export type ApprovalIn = {
  id: string
  kind: 'number' | 'registration' | 'domain' | 'site'
  clientName: string
  ringTo?: string | null
  at: Date
  /**
   * number: ask = Hell-level or GHL?; identity = waiting while a person passes GHL's ID check.
   * registration: review = filled and stopped before Send; blocked = it stopped and needs a person.
   * site: ask = build it?; publish = Lovable built it, publish it? (reviewLink = the copy in Lovable);
   * domain = it's live, connect their domain? (reviewLink = their Hell-level Domains).
   */
  stage?: 'ask' | 'identity' | 'review' | 'blocked' | 'publish' | 'domain'
  /** The client's GHL Phone System, where the ID check starts; null without a linked sub-account. */
  ghlLink?: string | null
  /** What the last try said (e.g. GHL still asked for the ID check, or what stopped the registration). */
  detail?: string | null
  /** registration: the number (E.164), and where a person sees what was filled (the client's folder in Sites). site: the client's folder in Sites. */
  number?: string | null
  reviewLink?: string | null
  /** domain: the three Forge suggests, and the client's Hell-level Domains page (search any name there). */
  choices?: DomainChoiceView[]
  domainsLink?: string | null
  /** site: the client's domain Forge would connect (managed = held in the Hub's Porkbun account, so the Hub sets its DNS). */
  siteDomain?: { name: string; managed: boolean } | null
}
/** A domain Forge suggests: Porkbun's all-in first-year price and the renewal, in cents. */
export type DomainChoiceView = { name: string; costCents: number; renewalCents: number | null }
/** A client's domain question once answered (src/lib/hl/domain-request.ts). */
export type DomainRequestIn = { id: string; accountId?: string; clientName: string; status: string; name: string | null; detail: string | null; decidedAt: Date | null; updatedAt: Date }
/**
 * A client's website build once a person answered (src/lib/hl/site-request.ts):
 * filling | copying | sending | building | waiting_on_lovable | built | held |
 * publishing | published | failed | declined.
 */
export type SiteRequestIn = {
  id: string
  clientId: string
  clientName: string
  status: string
  detail: string | null
  /** The client's copy in Lovable's editor, once it exists. */
  editorUrl: string | null
  /** Where it was published, and when. */
  liveUrl?: string | null
  publishedAt?: Date | null
  /** Their Hell-level sub-account (its Domains page). */
  accountId?: string | null
  /** The domain being (or that was) connected, the step (asking | lovable | records | live | queued | held), and when the step started / the domain showed the site. */
  domain?: string | null
  domainStep?: string | null
  domainStepAt?: Date | null
  domainAt?: Date | null
  /** The domain Forge would connect now: one ready, one still moving in, or none (src/lib/hl/site-plan.ts siteDomainChoice). */
  readyDomain?: { name: string; managed: boolean } | { waiting: string } | null
  /** Their SEO site has a GitHub repo (GitHub is connected in Lovable). */
  repoLinked?: boolean
  /** Clients: their site link is saved (the site went live). */
  siteLive: boolean
  /** When the current step started. */
  stepAt: Date | null
  finishedAt: Date | null
  updatedAt: Date
}
/** A client's Hell-level toll-free number request once answered (src/lib/hl/number-request.ts). */
export type NumberRequestIn = {
  id: string
  clientId?: string
  clientName: string
  /** buying | ghl_working | bought | declined | failed */
  status: string
  /** hl = Hell-level number; ghl = a number in the client's GHL sub-account. */
  route?: string
  number: string | null
  detail: string | null
  /** Why texting verification couldn't be filed yet, or Twilio's rejection; null otherwise. */
  verifyNote: string | null
  decidedAt: Date | null
  updatedAt: Date
  /** The bought number's texting verification: none | pending | in_review | approved | rejected. */
  verification?: string | null
  /** When it was filed, and when the number last changed (an approval lands then). */
  verificationAt?: Date | null
  verificationChangedAt?: Date | null
}

/** A GHL toll-free registration on the move (src/lib/ghl-number/queue.ts): queued, being filled or sent, sent. */
export type GhlRegistrationIn = { id: string; clientName: string; registration: string; running: boolean; at: Date }

export type OfficeInput = {
  journeyEvents: JourneyEventIn[]
  openStages: StageRowIn[]
  intakes: IntakeIn[]
  whopClaims: WhopClaimIn[]
  matchSuggestions: MatchSuggestionIn[]
  seoRuns: SeoRunIn[]
  a2p: A2pIn[]
  render: RenderMonitorIn
  subaccountJobs: SubaccountJobIn[]
  approvals: ApprovalIn[]
  numberRequests: NumberRequestIn[]
  ghlRegistrations?: GhlRegistrationIn[]
  domainRequests?: DomainRequestIn[]
  siteRequests?: SiteRequestIn[]
}

export const emptyInput = (): OfficeInput => ({
  approvals: [],
  journeyEvents: [],
  openStages: [],
  intakes: [],
  whopClaims: [],
  matchSuggestions: [],
  seoRuns: [],
  a2p: [],
  render: null,
  subaccountJobs: [],
  numberRequests: [],
})

// ---------- output ----------

export type OfficeBot = RosterEntry & {
  status: OfficeStatus
  task: string
  icon: BubbleIcon
  /** ISO time of the signal behind the status (null when idle with no history). */
  since: string | null
}
export type OfficeActivity = { id: string; at: string; botId: BotId; text: string; tone: OfficeStatus | 'done' }
export type OfficeHandoff = { id: string; from: BotId; to: BotId; at: string; clientName: string }
export type OfficeApproval = {
  id: string
  kind: 'number' | 'registration' | 'domain' | 'site'
  botId: BotId
  /** What the bot asks, e.g. "Buy a toll-free number for Acme Roofing in Hell-level?" */
  question: string
  note: string
  clientName: string
  /** Where its calls would ring (E.164), when a phone is on file. */
  ringTo: string | null
  at: string
  stage: 'ask' | 'identity' | 'review' | 'blocked' | 'publish' | 'domain'
  ghlLink: string | null
  detail: string | null
  /** registration: the client's folder in Sites, showing what was filled. */
  reviewLink: string | null
  /** domain: the suggestions to buy one of, and the client's Hell-level Domains page. */
  choices?: DomainChoiceView[]
  domainsLink?: string | null
}
/**
 * Something a bot needs from a person, or that broke, one per item (a bot's
 * bubble shows only its most pressing one): the Office's Requests tab.
 */
export type OfficeRequest = {
  id: string
  botId: BotId
  /** stuck = waiting on a person to do or fix something; error = something failed. */
  kind: 'stuck' | 'error'
  text: string
  at: string
  /** Where in the Hub to deal with it. */
  link: string | null
}
export type OfficeState = {
  generatedAt: string
  demo: boolean
  bots: OfficeBot[]
  activity: OfficeActivity[]
  handoffs: OfficeHandoff[]
  /** Questions waiting for a person's Yes or No. */
  approvals: OfficeApproval[]
  /** Everything stuck or failed, newest first (questions are in approvals). */
  requests: OfficeRequest[]
  counts: { working: number; idle: number; needsYou: number; error: number }
}

// ---------- mapping ----------

const PRIORITY: Record<OfficeStatus, number> = { error: 6, needs_you: 5, coding: 4, browsing: 4, terminal: 4, thinking: 3, idle: 0 }

type Candidate = { status: OfficeStatus; task: string; icon: BubbleIcon; at: Date }

export const ICON_FOR: Record<OfficeStatus, BubbleIcon> = {
  coding: 'code',
  browsing: 'globe',
  terminal: 'terminal',
  thinking: 'dots',
  needs_you: 'alert',
  error: 'error',
  idle: null,
}

export function isWorking(s: OfficeStatus) {
  return s === 'coding' || s === 'browsing' || s === 'terminal' || s === 'thinking'
}

const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
/** "+18556762067" → "(855) 676-2067". */
const phone = (n: string | null | undefined) => {
  const d = (n ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (n ?? '')
}

/** Pick the strongest candidate: priority first, then the newest. */
export function pickCandidate(cands: Candidate[]): Candidate | null {
  let best: Candidate | null = null
  for (const c of cands) {
    if (!best || PRIORITY[c.status] > PRIORITY[best.status] || (PRIORITY[c.status] === PRIORITY[best.status] && c.at > best.at)) best = c
  }
  return best
}

export function seoRunIsError(r: Pick<SeoRunIn, 'status' | 'error'>) {
  return r.status === 'failed' || r.status === 'failure' || /blocked/i.test(r.error ?? '')
}

/** Journey event -> feed line. */
export function journeyEventText(e: JourneyEventIn): string {
  const label = STAGE_LABEL[e.stage] ?? e.stage
  const verb =
    e.toStatus === 'done' ? 'finished' : e.toStatus === 'blocked' ? 'blocked on' : e.toStatus === 'in_progress' ? 'started' : 'reset'
  const note = e.note ? ` — ${clip(e.note, 70)}` : ''
  return `${verb} ${label} for ${e.clientName}${note}`
}

export function journeyEventTone(e: Pick<JourneyEventIn, 'stage' | 'toStatus'>): OfficeActivity['tone'] {
  if (e.toStatus === 'done') return 'done'
  if (e.toStatus === 'blocked') return 'needs_you'
  if (e.toStatus === 'in_progress') return STAGE_WORK[e.stage] ?? 'coding'
  return 'idle'
}

/**
 * Handoffs: for the same client, a stage finishing followed by a later
 * stage's event (normally advanceJourneyStage's done -> next in_progress)
 * means the first stage's bot walks over to the next stage's bot.
 */
export function deriveHandoffs(events: JourneyEventIn[], now: Date): OfficeHandoff[] {
  const byClient = new Map<string, JourneyEventIn[]>()
  for (const e of events) {
    const list = byClient.get(e.clientId) ?? []
    list.push(e)
    byClient.set(e.clientId, list)
  }
  const out: OfficeHandoff[] = []
  for (const list of byClient.values()) {
    const sorted = [...list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]
      const cur = sorted[i]
      if (prev.toStatus !== 'done' || prev.stage === cur.stage) continue
      const from = STAGE_BOT[prev.stage]
      const to = STAGE_BOT[cur.stage]
      if (!from || !to || from === to) continue
      if (now.getTime() - cur.createdAt.getTime() > HANDOFF_MS) continue
      out.push({ id: `${prev.id}>${cur.id}`, from, to, at: cur.createdAt.toISOString(), clientName: cur.clientName })
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at))
}

export function deriveOffice(input: OfficeInput, now: Date, opts: { demo?: boolean; feedLimit?: number } = {}): OfficeState {
  const t = now.getTime()
  const age = (d: Date) => t - d.getTime()
  const cands = new Map<BotId, Candidate[]>(ROSTER.map((r) => [r.id, []]))
  const add = (id: BotId, c: Candidate) => cands.get(id)!.push(c)
  const requests: OfficeRequest[] = []
  const request = (id: string, botId: BotId, kind: OfficeRequest['kind'], text: string, at: Date, link: string | null = null) =>
    requests.push({ id, botId, kind, text: clip(text, 220), at: at.toISOString(), link })
  const activity: OfficeActivity[] = []
  const feed = (id: string, at: Date, botId: BotId, text: string, tone: OfficeActivity['tone']) =>
    activity.push({ id, at: at.toISOString(), botId, text: clip(text, 140), tone })

  // Journey events (feed + recent work per stage bot).
  for (const e of input.journeyEvents) {
    const bot = STAGE_BOT[e.stage]
    if (!bot) continue
    feed(`je:${e.id}`, e.createdAt, bot, journeyEventText(e), journeyEventTone(e))
    const a = age(e.createdAt)
    const label = STAGE_LABEL[e.stage] ?? e.stage
    if (e.toStatus === 'in_progress' && a <= ACTIVE_MS) {
      const st = STAGE_WORK[e.stage] ?? 'coding'
      add(bot, { status: st, task: `${label}: ${e.clientName}`, icon: ICON_FOR[st], at: e.createdAt })
    } else if (e.toStatus === 'done' && a <= DONE_MS) {
      const st = STAGE_WORK[e.stage] ?? 'coding'
      add(bot, { status: st, task: `Wrapped up ${label} for ${e.clientName}`, icon: 'check', at: e.createdAt })
    }
  }

  // Open stage rows: blocked -> Needs you; fresh in_progress -> working.
  for (const s of input.openStages) {
    const bot = STAGE_BOT[s.stage]
    if (!bot) continue
    const label = STAGE_LABEL[s.stage] ?? s.stage
    if (s.status === 'blocked') {
      add(bot, { status: 'needs_you', task: clip(`${label} blocked for ${s.clientName}${s.note ? `: ${s.note}` : ''}`), icon: 'alert', at: s.updatedAt })
      request(`st:${s.clientId}:${s.stage}`, bot, 'stuck', `${label} is blocked for ${s.clientName}${s.note ? `: ${s.note}` : ''}`, s.updatedAt, `/sites/${s.clientId}`)
    } else if (s.status === 'in_progress' && age(s.updatedAt) <= STALE_MS) {
      const st = STAGE_WORK[s.stage] ?? 'coding'
      add(bot, { status: st, task: `${label}: ${s.clientName}`, icon: ICON_FOR[st], at: s.updatedAt })
    }
  }

  // Onboarding forms.
  for (const i of input.intakes) {
    const who = i.name || 'a new client'
    feed(`in:${i.id}`, i.receivedAt, 'ivy', `Received onboarding form from ${who}`, 'coding')
    if (age(i.receivedAt) <= ACTIVE_MS) add('ivy', { status: 'coding', task: `Processing onboarding form: ${who}`, icon: 'folder', at: i.receivedAt })
  }

  // Whop sign-up claims (one per announced membership).
  for (const w of input.whopClaims) {
    feed(`wh:${w.membershipId}`, w.claimedAt, 'wren', `Announced new Whop signup (via ${w.source})`, 'browsing')
    if (age(w.claimedAt) <= ACTIVE_MS) add('wren', { status: 'browsing', task: 'Announcing a new Whop signup', icon: 'globe', at: w.claimedAt })
  }

  // Sub-account match suggestions.
  const review = input.matchSuggestions.filter((m) => m.status === 'needs_review')
  for (const m of input.matchSuggestions) {
    feed(`ms:${m.id}`, m.createdAt, 'atlas', `Suggested GHL match "${m.locationName}" for ${m.clientName} (score ${m.score})`, m.status === 'needs_review' ? 'needs_you' : 'browsing')
  }
  for (const m of review) request(`ms:${m.id}`, 'atlas', 'stuck', `Review the suggested GHL sub-account “${m.locationName}” for ${m.clientName} (score ${m.score})`, m.updatedAt, '/clients')
  if (review.length) {
    const newest = review.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a))
    add('atlas', {
      status: 'needs_you',
      task: review.length === 1 ? `Review sub-account match for ${newest.clientName}` : `${review.length} sub-account matches need review`,
      icon: 'alert',
      at: newest.updatedAt,
    })
  }

  // Questions waiting for an answer: Echo asks where to get a new client's toll-free number,
  // and whether to send GHL's toll-free registration it filled (or says what stopped it).
  // Forge's domain questions are mapped below.
  const echoAsks = input.approvals.filter((a) => a.kind !== 'domain' && a.kind !== 'site')
  /** Echo's stages: publishing is Forge's. */
  type EchoStage = Exclude<OfficeApproval['stage'], 'publish' | 'domain'>
  const echoApprovals = [...echoAsks]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((a): OfficeApproval & { stage: EchoStage } => {
      const stage: EchoStage = !a.stage || a.stage === 'publish' || a.stage === 'domain' ? 'ask' : a.stage
      const ring = a.ringTo ? `Calls ring ${phone(a.ringTo)}.` : 'No business phone is on file, so every call counts as missed and gets the text-back.'
      const num = a.number ? phone(a.number) : 'their number'
      const words: Record<EchoStage, { question: string; note: string }> = {
        // Hell-level only since 2026-11-13: clients set up in GHL keep their numbers and aren't asked.
        ask: {
          question: `Buy a toll-free number for ${a.clientName} in Hell-level?`,
          note: `About $2.15/month on Genisys’s Twilio, no ID check. ${ring} Texting verification is filed once their site link is in.`,
        },
        identity: {
          question: `Verify ${a.clientName}’s identity in GHL, then press Identification complete.`,
          note: 'In GHL: Phone System → Add Number → pick a toll-free number → Proceed to Buy, then finish the ID check (ID and selfie). The Hub uses the number you buy there, points its calls and handles the rest.',
        },
        review: {
          question: `Send ${a.clientName}’s toll-free registration in GHL?`,
          note: `The Hub filled GHL’s toll-free form for ${num} from their details and live site, and stopped before sending. Send it fills the form again and sends it. GHL says reviews can take up to 4–6 weeks.`,
        },
        blocked: {
          question: `${a.clientName}’s toll-free registration in GHL stopped.`,
          note: `Fix what it says below, then Try again: the Hub fills GHL’s form for ${num} again and asks you before sending.`,
        },
      }
      return {
        id: a.id,
        kind: a.kind,
        botId: 'echo' as const,
        stage,
        question: words[stage].question,
        note: words[stage].note,
        clientName: a.clientName,
        ringTo: a.ringTo ?? null,
        ghlLink: a.ghlLink ?? null,
        detail: a.detail ?? null,
        reviewLink: a.reviewLink ?? null,
        at: a.at.toISOString(),
      }
    })
  const approvals: OfficeApproval[] = [...echoApprovals]
  const asked: Record<EchoStage, (name: string) => string> = {
    ask: (n) => `Asked to buy a toll-free number for ${n}`,
    identity: (n) => `Waiting on GHL’s ID check for ${n}`,
    review: (n) => `Filled ${n}’s toll-free registration in GHL; waiting for your OK`,
    blocked: (n) => `${n}’s toll-free registration in GHL needs you`,
  }
  for (const a of echoApprovals) feed(`ap:${a.id}:${a.stage}:${a.at}`, new Date(a.at), 'echo', asked[a.stage](a.clientName), 'needs_you')
  if (echoApprovals.length) {
    const newest = echoAsks.reduce((x, y) => (y.at > x.at ? y : x))
    const one = echoApprovals[0]
    const task: Record<EchoStage, string> = {
      ask: `Asking: buy a toll-free number for ${one.clientName}?`,
      identity: `Waiting on the GHL ID check for ${one.clientName}`,
      review: `Asking: send ${one.clientName}’s toll-free registration in GHL?`,
      blocked: `${one.clientName}’s toll-free registration in GHL needs you`,
    }
    add('echo', {
      status: 'needs_you',
      task: echoApprovals.length === 1 ? task[one.stage] : `${echoApprovals.length} toll-free ${echoApprovals.every((x) => x.kind === 'number') ? 'numbers' : 'questions'} waiting for you`,
      icon: 'alert',
      at: newest.at,
    })
  }

  // Forge asks which of three domains to buy for a new client (src/lib/hl/domain-request.ts).
  const domainAsks = input.approvals.filter((a) => a.kind === 'domain').sort((a, b) => a.at.getTime() - b.at.getTime())
  for (const a of domainAsks) {
    const choices = a.choices ?? []
    approvals.push({
      id: a.id,
      kind: 'domain',
      botId: 'forge',
      stage: 'ask',
      question: choices.length ? `Buy a website domain for ${a.clientName}?` : `No domain to suggest for ${a.clientName}.`,
      note: choices.length
        ? 'Available on Porkbun right now. Each price is the first year, all in. The one you press is bought at once into their Hell-level sub-account, which keeps it renewing.'
        : 'Search any name in their Hell-level → Settings → Domains, or answer No.',
      clientName: a.clientName,
      ringTo: null,
      ghlLink: null,
      detail: a.detail ?? null,
      reviewLink: null,
      choices,
      domainsLink: a.domainsLink ?? null,
      at: a.at.toISOString(),
    })
    feed(`dq:${a.id}:${a.at.getTime()}`, a.at, 'forge', `Asked which domain to buy for ${a.clientName}`, 'needs_you')
  }
  if (domainAsks.length) {
    const newest = domainAsks[domainAsks.length - 1]
    add('forge', {
      status: 'needs_you',
      task: domainAsks.length === 1 ? `Asking: which domain for ${newest.clientName}?` : `${domainAsks.length} domains to pick`,
      icon: 'alert',
      at: newest.at,
    })
  }
  // After the answer: buying, bought, failed, None of these.
  for (const r of input.domainRequests ?? []) {
    const at = r.decidedAt ?? r.updatedAt
    if (r.status === 'buying') {
      add('forge', { status: 'terminal', task: `Buying ${r.name ?? 'a domain'} for ${r.clientName}`, icon: 'terminal', at: r.updatedAt })
    } else if (r.status === 'bought') {
      feed(`dr:${r.id}:bought`, at, 'forge', `Bought ${r.name ?? 'a domain'} for ${r.clientName}`, 'done')
      if (age(at) <= DONE_MS) add('forge', { status: 'terminal', task: `Bought ${r.name ?? 'a domain'} for ${r.clientName}`, icon: 'check', at })
    } else if (r.status === 'failed' && age(r.updatedAt) <= SUBACCOUNT_OPEN_MS) {
      const why = r.detail ? `: ${clip(r.detail, 80)}` : ''
      add('forge', { status: 'error', task: clip(`Buying ${r.clientName}'s domain didn't finish${why}`), icon: 'error', at: r.updatedAt })
      request(`dr:${r.id}:failed`, 'forge', 'error', `Buying ${r.clientName}'s domain didn't finish${r.detail ? `: ${r.detail}` : ''}`, r.updatedAt, r.accountId ? `/hell-level/${r.accountId}/settings?tab=domains` : null)
      feed(`dr:${r.id}:failed:${r.updatedAt.getTime()}`, r.updatedAt, 'forge', clip(`Buying ${r.clientName}'s domain didn't finish${why}`, 140), 'error')
    } else if (r.status === 'declined') {
      feed(`dr:${r.id}:declined`, at, 'forge', `No suggested domain for ${r.clientName} (None of these)`, 'thinking')
    }
  }

  // Forge asks whether to build a new client's website, once Lovable built it whether to publish it,
  // and once it's live whether to connect their domain (src/lib/hl/site-request.ts).
  const siteAsks = input.approvals.filter((a) => a.kind === 'site').sort((a, b) => a.at.getTime() - b.at.getTime())
  const connectNote = (d: { name: string; managed: boolean }) =>
    d.managed
      ? `The Hub asks Lovable to connect ${d.name} (one short chat message, about a credit), sets its DNS at Porkbun, waits until it shows the site (Lovable’s certificate can take a few hours), then saves it as their site link in Clients.`
      : `The Hub asks Lovable to connect ${d.name} (one short chat message, about a credit) and lists the DNS records to add where its DNS is managed. Once they’re in and it shows the site, it’s saved as their site link in Clients.`
  for (const a of siteAsks) {
    const stage = a.stage === 'publish' || a.stage === 'domain' ? a.stage : 'ask'
    const d = a.siteDomain ?? null
    const words = {
      ask: {
        question: `Build ${a.clientName}’s website?`,
        note: 'Claude fills Ethan’s one-shot from their onboarding answers and photos (about $0.50), with their Hell-level quote form and chat widget. Then the Hub copies Robert Taylor’s site in Lovable (free) and sends it the one-shot (Lovable credits). Nothing is published.',
        asked: `Asked whether to build ${a.clientName}’s website`,
      },
      publish: {
        question: `Publish ${a.clientName}’s website?`,
        note: d
          ? `Lovable built it. Look it over in Lovable first. Publishing puts it live at a lovable.app address (free, no Lovable credits), then connects ${d.name}: ${connectNote(d)}`
          : 'Lovable built it. Look it over in Lovable first. Publishing puts it live at a lovable.app address (free, no Lovable credits). They have no domain yet: Forge asks to connect one once they do.',
        asked: `Asked whether to publish ${a.clientName}’s website`,
      },
      domain: {
        question: `Connect ${d?.name ?? 'their domain'} to ${a.clientName}’s website?`,
        note: d ? connectNote(d) : 'The Hub asks Lovable to connect it, sets its DNS, and saves it as their site link in Clients once it shows the site.',
        asked: `Asked whether to connect ${d?.name ?? 'a domain'} to ${a.clientName}’s website`,
      },
    }[stage]
    approvals.push({
      id: a.id,
      kind: 'site',
      botId: 'forge',
      stage,
      question: words.question,
      note: words.note,
      clientName: a.clientName,
      ringTo: null,
      ghlLink: null,
      detail: a.detail ?? null,
      reviewLink: a.reviewLink ?? null,
      at: a.at.toISOString(),
    })
    feed(`sq:${a.id}:${stage === 'ask' ? '' : `${stage}:`}${a.at.getTime()}`, a.at, 'forge', words.asked, 'needs_you')
  }
  if (siteAsks.length) {
    const newest = siteAsks[siteAsks.length - 1]
    const verb = (x: ApprovalIn) => (x.stage === 'publish' ? 'publish' : x.stage === 'domain' ? `connect ${x.siteDomain?.name ?? 'a domain'} to` : 'build')
    add('forge', {
      status: 'needs_you',
      task: siteAsks.length === 1 ? `Asking: ${verb(newest)} ${newest.clientName}’s website?` : `${siteAsks.length} website questions waiting for you`,
      icon: 'alert',
      at: newest.at,
    })
  }
  // After the Yes: filling, copying, sending, building, waiting on a person in Lovable, built, failed, Not now.
  for (const r of input.siteRequests ?? []) {
    const at = r.stepAt ?? r.updatedAt
    const lovable = r.editorUrl ?? `/sites/${r.clientId}`
    const retrying = r.detail?.startsWith('Trying again') ? ' (retrying)' : ''
    if (r.status === 'filling') {
      add('forge', { status: 'thinking', task: `Filling ${r.clientName}’s one-shot with Claude${retrying}`, icon: 'dots', at })
    } else if (r.status === 'copying') {
      add('forge', { status: 'browsing', task: `Copying the template in Lovable for ${r.clientName}${retrying}`, icon: 'globe', at })
    } else if (r.status === 'sending') {
      add('forge', { status: 'terminal', task: `Sending ${r.clientName}’s one-shot to Lovable${retrying}`, icon: 'terminal', at })
    } else if (r.status === 'building') {
      add('forge', { status: 'coding', task: `Lovable is building ${r.clientName}’s website`, icon: 'code', at })
      feed(`sb:${r.id}:sent:${at.getTime()}`, at, 'forge', `Sent ${r.clientName}’s one-shot to Lovable`, 'coding')
    } else if (r.status === 'waiting_on_lovable') {
      const why = r.detail ? `: ${r.detail}` : ''
      add('forge', { status: 'needs_you', task: clip(`Lovable is waiting for you on ${r.clientName}’s website${why}`), icon: 'alert', at: r.updatedAt })
      request(`sb:${r.id}:waiting`, 'forge', 'stuck', `Lovable is waiting for a person on ${r.clientName}’s website${why}`, r.updatedAt, lovable)
    } else if (r.status === 'built' || r.status === 'held') {
      // Forge's Publish question is the next step (an approval); Not now leaves it in their folder.
      const done = r.finishedAt ?? r.updatedAt
      feed(`sb:${r.id}:built`, done, 'forge', `Built ${r.clientName}’s website in Lovable`, 'done')
      if (age(done) <= DONE_MS) add('forge', { status: 'coding', task: `Built ${r.clientName}’s website in Lovable`, icon: 'check', at: done })
      if (r.status === 'held') feed(`sb:${r.id}:held`, r.updatedAt, 'forge', `Not publishing ${r.clientName}’s website for now`, 'thinking')
    } else if (r.status === 'publishing') {
      add('forge', { status: 'browsing', task: `Publishing ${r.clientName}’s website in Lovable${retrying}`, icon: 'globe', at })
    } else if (r.status === 'published') {
      const live = r.publishedAt ?? r.updatedAt
      const where = r.liveUrl ? ` at ${r.liveUrl}` : ''
      const domains = r.accountId ? `/hell-level/${r.accountId}/settings?tab=domains` : `/sites/${r.clientId}`
      feed(`sb:${r.id}:published`, live, 'forge', `Published ${r.clientName}’s website${where}`, 'done')
      if (age(live) <= DONE_MS) add('forge', { status: 'coding', task: `Published ${r.clientName}’s website`, icon: 'check', at: live })
      const ready = r.readyDomain ?? null
      if (r.detail?.startsWith('Connecting') && age(r.updatedAt) <= SUBACCOUNT_OPEN_MS) {
        // A connect that stopped: Forge's question is back, with what went wrong.
        request(`sb:${r.id}:connect-failed`, 'forge', 'error', `${r.clientName}: ${r.detail}`, r.updatedAt, lovable)
      } else if (r.domainStep === 'held') {
        feed(`sb:${r.id}:domain-held`, r.updatedAt, 'forge', `Not connecting ${r.clientName}’s domain for now`, 'thinking')
      } else if (!r.siteLive && ready && 'waiting' in ready && age(live) <= SUBACCOUNT_OPEN_MS) {
        request(`sb:${r.id}:domain-moving`, 'forge', 'stuck', `${r.clientName}’s website is live${where}. Their domain ${ready.waiting} is still moving in; Forge asks to connect it once it has.`, live, domains)
      } else if (!r.siteLive && !ready && age(live) <= SUBACCOUNT_OPEN_MS) {
        request(
          `sb:${r.id}:no-domain`,
          'forge',
          'stuck',
          `${r.clientName}’s website is live${where} but has no domain yet. Answer Forge’s domain question for them, or add theirs in Hell-level → Domains; Forge then asks to connect it.`,
          live,
          domains,
        )
      }
      if (r.detail?.includes('didn’t load') && age(live) <= SUBACCOUNT_OPEN_MS) {
        request(`sb:${r.id}:pages`, 'forge', 'error', `${r.clientName}’s website is live, but its privacy or terms page didn’t load, and its form and chat link them. Look in Lovable.`, live, lovable)
      }
    } else if (r.status === 'connecting') {
      const name = r.domain ?? 'their domain'
      const stepAt = r.domainStepAt ?? r.updatedAt
      const domains = r.accountId ? `/hell-level/${r.accountId}/settings?tab=domains` : lovable
      if (r.domainStep === 'records') {
        add('forge', { status: 'needs_you', task: clip(`Connecting ${name} to ${r.clientName}’s website needs you`), icon: 'alert', at: stepAt })
        request(`sb:${r.id}:records`, 'forge', 'stuck', `${r.clientName}: ${r.detail ?? `${name} needs its DNS records added.`}`, stepAt, domains)
      } else if (r.domainStep === 'live') {
        add('forge', { status: 'thinking', task: `Waiting for ${name} to show ${r.clientName}’s website`, icon: 'dots', at: stepAt })
        if (r.detail?.startsWith('Still waiting')) request(`sb:${r.id}:slow`, 'forge', 'stuck', `${r.clientName}: ${r.detail}`, r.updatedAt, lovable)
      } else {
        add('forge', { status: 'browsing', task: `Connecting ${name} to ${r.clientName}’s website in Lovable${retrying}`, icon: 'globe', at: stepAt })
      }
    } else if (r.status === 'connected') {
      const done = r.domainAt ?? r.updatedAt
      const name = r.domain ?? 'their domain'
      feed(`sb:${r.id}:connected`, done, 'forge', `${name} now shows ${r.clientName}’s website`, 'done')
      if (age(done) <= DONE_MS) add('forge', { status: 'coding', task: `${name} now shows ${r.clientName}’s website`, icon: 'check', at: done })
      // GitHub is connected only in Lovable's editor; the SEO engine needs it.
      if (!r.repoLinked && age(done) <= SUBACCOUNT_OPEN_MS) {
        request(`sb:${r.id}:github`, 'forge', 'stuck', `${r.clientName}’s website is live on ${name}. Connect GitHub in Lovable (the site → GitHub) so the SEO engine can work on it.`, done, lovable)
      }
    } else if (r.status === 'failed' && age(r.updatedAt) <= SUBACCOUNT_OPEN_MS) {
      const why = r.detail ? `: ${clip(r.detail, 80)}` : ''
      add('forge', { status: 'error', task: clip(`Building ${r.clientName}’s website didn’t finish${why}`), icon: 'error', at: r.updatedAt })
      request(`sb:${r.id}:failed`, 'forge', 'error', `Building ${r.clientName}’s website didn’t finish${r.detail ? `: ${r.detail}` : ''}`, r.updatedAt, lovable)
      feed(`sb:${r.id}:failed:${r.updatedAt.getTime()}`, r.updatedAt, 'forge', clip(`Building ${r.clientName}’s website didn’t finish${why}`, 140), 'error')
    } else if (r.status === 'declined') {
      feed(`sb:${r.id}:declined`, r.updatedAt, 'forge', `Not building ${r.clientName}’s website for now`, 'thinking')
    }
  }

  // Sub-account worker jobs: creating, queued, needs a person, failed, stalled.
  const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000))
  /** `what` is set for lead-workflow jobs ("Lead workflows for X"); unset means a sub-account. */
  const needsPerson: { name: string; at: Date; why: string; what?: string; link: string | null }[] = []
  const broken: { text: string; at: Date; customize?: boolean; link: string | null }[] = []
  for (const j of input.subaccountJobs) {
    // Where a person deals with it: the site form in Sites, the copy on the Automation Copy board, the sub-account on the client's GHL board.
    const link = j.clientId ? (j.kind === 'form' ? `/sites/${j.clientId}` : j.kind === 'customize' ? `/automation-copy/${j.clientId}` : `/clients/${j.clientId}/ghl`) : null
    const why = j.detail ? `: ${clip(j.detail, 80)}` : ''
    const ended = j.finishedAt ?? j.updatedAt
    if (j.kind === 'form') {
      const what = `Site form for ${j.clientName}`
      if (j.status === 'running') {
        const beat = j.heartbeatAt ?? j.updatedAt
        if (age(beat) > SUBACCOUNT_STALL_MS) broken.push({ text: `${what} stalled (no heartbeat for ${minutes(age(beat))} min)`, at: beat, customize: true, link })
        else add('atlas', { status: 'browsing', task: `Making ${j.clientName}'s site form theirs in GHL`, icon: 'globe', at: j.updatedAt })
      } else if (j.status === 'queued') {
        const waited = t - j.nextAttemptAt.getTime()
        if (waited > SUBACCOUNT_WAIT_MS) needsPerson.push({ name: j.clientName, at: j.nextAttemptAt, why: `: waiting ${minutes(waited)} min for the worker`, what, link })
        else add('atlas', { status: 'thinking', task: `${what} queued`, icon: 'dots', at: j.updatedAt })
      } else if (j.status === 'needs_human' && age(ended) <= SUBACCOUNT_OPEN_MS) {
        needsPerson.push({ name: j.clientName, at: ended, why, what, link })
        feed(`fj:${j.id}:${ended.getTime()}`, ended, 'atlas', clip(`${what} needs a person${why}`), 'needs_you')
      } else if (j.status === 'failed' && age(ended) <= SUBACCOUNT_OPEN_MS) {
        broken.push({ text: clip(`${what} failed${why}`), at: ended, customize: true, link })
        feed(`fj:${j.id}:${ended.getTime()}`, ended, 'atlas', clip(`${what} failed${why}`), 'error')
      } else if (j.status === 'succeeded') {
        feed(`fj:${j.id}:${ended.getTime()}`, ended, 'atlas', `Made ${j.clientName}'s site form theirs in GHL`, 'done')
        if (age(ended) <= DONE_MS) add('atlas', { status: 'browsing', task: `Made ${j.clientName}'s site form theirs`, icon: 'check', at: ended })
      }
      continue
    }
    if (j.kind === 'customize') {
      const what = `Lead workflows for ${j.clientName}`
      if (j.status === 'running') {
        const beat = j.heartbeatAt ?? j.updatedAt
        if (age(beat) > SUBACCOUNT_STALL_MS) broken.push({ text: `${what} stalled (no heartbeat for ${minutes(age(beat))} min)`, at: beat, customize: true, link })
        else add('atlas', { status: 'browsing', task: `Customizing lead workflows for ${j.clientName} with Workflow AI`, icon: 'globe', at: j.updatedAt })
      } else if (j.status === 'queued') {
        const waited = t - j.nextAttemptAt.getTime()
        if (waited > SUBACCOUNT_WAIT_MS) needsPerson.push({ name: j.clientName, at: j.nextAttemptAt, why: `: waiting ${minutes(waited)} min for the worker`, what, link })
        else add('atlas', { status: 'thinking', task: `${what} queued`, icon: 'dots', at: j.updatedAt })
      } else if ((j.status === 'needs_human' || j.status === 'held') && age(ended) <= SUBACCOUNT_OPEN_MS) {
        needsPerson.push({ name: j.clientName, at: ended, why, what, link })
        feed(`cj:${j.id}:${ended.getTime()}`, ended, 'atlas', clip(`${what} ${j.status === 'held' ? 'wait on a missing detail' : 'need a person'}${why}`), 'needs_you')
      } else if (j.status === 'failed' && age(ended) <= SUBACCOUNT_OPEN_MS) {
        broken.push({ text: clip(`${what} failed${why}`), at: ended, customize: true, link })
        feed(`cj:${j.id}:${ended.getTime()}`, ended, 'atlas', clip(`${what} failed${why}`), 'error')
      } else if (j.status === 'succeeded') {
        feed(`cj:${j.id}:${ended.getTime()}`, ended, 'atlas', `Put the Hub's copy into ${j.clientName}'s lead workflows`, 'done')
        if (age(ended) <= DONE_MS) add('atlas', { status: 'browsing', task: `Customized ${j.clientName}'s lead workflows`, icon: 'check', at: ended })
      }
      continue
    }
    if (j.status === 'running') {
      const beat = j.heartbeatAt ?? j.updatedAt
      if (age(beat) > SUBACCOUNT_STALL_MS) {
        broken.push({ text: `Sub-account job for ${j.clientName} stalled (no heartbeat for ${minutes(age(beat))} min)`, at: beat, link })
      } else {
        add('atlas', { status: 'browsing', task: `Creating GHL sub-account for ${j.clientName}`, icon: 'globe', at: j.updatedAt })
      }
    } else if (j.status === 'queued') {
      const waited = t - j.nextAttemptAt.getTime()
      if (waited > SUBACCOUNT_WAIT_MS) {
        needsPerson.push({ name: j.clientName, at: j.nextAttemptAt, why: `: waiting ${minutes(waited)} min for the worker`, link })
      } else {
        add('atlas', { status: 'thinking', task: `Sub-account queued for ${j.clientName}`, icon: 'dots', at: j.updatedAt })
      }
    } else if (j.status === 'needs_human' && age(ended) <= SUBACCOUNT_OPEN_MS) {
      needsPerson.push({ name: j.clientName, at: ended, why, link })
      feed(`sj:${j.id}:${ended.getTime()}`, ended, 'atlas', `Sub-account for ${j.clientName} needs a person${why}`, 'needs_you')
    } else if (j.status === 'failed' && age(ended) <= SUBACCOUNT_OPEN_MS) {
      broken.push({ text: clip(`Sub-account for ${j.clientName} failed${why}`), at: ended, link })
      feed(`sj:${j.id}:${ended.getTime()}`, ended, 'atlas', `Sub-account for ${j.clientName} failed${why}`, 'error')
    } else if (j.status === 'succeeded') {
      const verb = /^created\b/i.test(j.detail ?? '') ? 'Created' : 'Linked'
      feed(`sj:${j.id}:${ended.getTime()}`, ended, 'atlas', `${verb} the GHL sub-account for ${j.clientName}`, 'done')
      if (age(ended) <= DONE_MS) add('atlas', { status: 'browsing', task: `${verb} the GHL sub-account for ${j.clientName}`, icon: 'check', at: ended })
    } else if (j.status === 'dry_run') {
      feed(`sj:${j.id}:${ended.getTime()}`, ended, 'atlas', `Rehearsed the sub-account for ${j.clientName} (dry run)`, 'thinking')
    }
  }
  // "Lead workflows for X need you", "Site form for X needs you".
  const needVerb = (what: string) => (/^Lead workflows/.test(what) ? 'need' : 'needs')
  for (const p of needsPerson) request(`np:${p.what ?? 'sub'}:${p.name}:${p.at.getTime()}`, 'atlas', 'stuck', p.what ? `${p.what} ${needVerb(p.what)} you${p.why}` : `Sub-account for ${p.name} needs you${p.why}`, p.at, p.link)
  for (const b of broken) request(`br:${b.text}:${b.at.getTime()}`, 'atlas', 'error', b.text, b.at, b.link)
  if (broken.length) {
    const newest = broken.reduce((a, b) => (b.at > a.at ? b : a))
    const noun = broken.some((b) => b.customize) ? 'GHL jobs' : 'sub-account jobs'
    add('atlas', { status: 'error', task: broken.length === 1 ? newest.text : `${broken.length} ${noun} failed or stalled`, icon: 'error', at: newest.at })
  }
  if (needsPerson.length) {
    const newest = needsPerson.reduce((a, b) => (b.at > a.at ? b : a))
    const one = newest.what ? `${newest.what} ${needVerb(newest.what)} you${newest.why}` : `Sub-account for ${newest.name} needs you${newest.why}`
    const noun = needsPerson.some((p) => p.what) ? 'GHL jobs' : 'sub-accounts'
    add('atlas', {
      status: 'needs_you',
      task: needsPerson.length === 1 ? clip(one) : `${needsPerson.length} ${noun} need you`,
      icon: 'alert',
      at: newest.at,
    })
  }

  // SEO runs.
  for (const r of input.seoRuns) {
    const started = r.startedAt ?? r.createdAt
    if (r.status === 'running') {
      add('scout', { status: r.stage === 'ship' || r.stage === 'commit' || r.stage === 'verify' ? 'terminal' : 'coding', task: `SEO ${r.stage} for ${r.siteName}`, icon: r.stage === 'ship' || r.stage === 'commit' ? 'terminal' : 'code', at: r.updatedAt })
      feed(`seo:${r.id}:start`, started, 'scout', `Started SEO run for ${r.siteName}`, 'coding')
    } else if (r.status === 'queued') {
      add('scout', { status: 'thinking', task: `SEO run queued for ${r.siteName}`, icon: 'dots', at: r.createdAt })
      feed(`seo:${r.id}:queued`, r.createdAt, 'scout', `Queued SEO run for ${r.siteName}`, 'thinking')
    } else if (seoRunIsError(r)) {
      const at = r.finishedAt ?? r.updatedAt
      const why = r.error ? `: ${clip(r.error, 60)}` : ''
      if (age(at) <= ERROR_MS) {
        add('scout', { status: 'error', task: clip(`SEO run failed for ${r.siteName}${why}`), icon: 'error', at })
        request(`seo:${r.id}:fail`, 'scout', 'error', `SEO run failed for ${r.siteName}${r.error ? `: ${r.error}` : ''}`, at, '/seo')
      }
      feed(`seo:${r.id}:fail`, at, 'scout', `SEO run failed for ${r.siteName}${why}`, 'error')
    } else if (r.status.startsWith('awaiting_')) {
      const at = r.finishedAt ?? r.updatedAt
      feed(`seo:${r.id}:${r.status}`, at, 'scout', `SEO run for ${r.siteName} is ${r.status.replace('_', ' ')}`, 'needs_you')
      if (r.status === 'awaiting_review') {
        add('scout', { status: 'needs_you', task: `SEO drafts for ${r.siteName} await review`, icon: 'alert', at })
        request(`seo:${r.id}:review`, 'scout', 'stuck', `SEO drafts for ${r.siteName} are waiting for your review`, at, '/seo')
      }
    } else if (r.finishedAt) {
      feed(`seo:${r.id}:end`, r.finishedAt, 'scout', `SEO run ${r.status} for ${r.siteName}`, 'done')
      if (age(r.finishedAt) <= DONE_MS) add('scout', { status: 'coding', task: `Finished SEO run for ${r.siteName}`, icon: 'check', at: r.finishedAt })
    }
  }

  // A2P filings.
  for (const a of input.a2p) {
    feed(`a2p:${a.id}:${a.updatedAt.getTime()}`, a.updatedAt, 'echo', `A2P for ${a.accountName} is at "${a.stage}"${a.note ? ` — ${clip(a.note, 60)}` : ''}`, 'terminal')
    if (age(a.updatedAt) <= ACTIVE_MS) add('echo', { status: 'terminal', task: `A2P ${a.stage}: ${a.accountName}`, icon: 'terminal', at: a.updatedAt })
  }

  // Hell-level toll-free numbers after the Office answer: buying, bought, a blocked texting verification, failed.
  for (const r of input.numberRequests) {
    const at = r.decidedAt ?? r.updatedAt
    if (r.status === 'buying') {
      add('echo', { status: 'terminal', task: `Buying a toll-free number for ${r.clientName}`, icon: 'terminal', at: r.updatedAt })
    } else if (r.status === 'ghl_working') {
      add('echo', { status: 'browsing', task: `Getting ${r.clientName}’s toll-free number in GHL`, icon: 'globe', at: r.updatedAt })
    } else if (r.status === 'bought') {
      const num = r.number ? phone(r.number) : 'a toll-free number'
      const where = r.route === 'ghl' ? ' in GHL' : ''
      feed(`nr:${r.id}:bought`, r.route === 'ghl' ? r.updatedAt : at, 'echo', `Got ${num}${where} for ${r.clientName}`, 'done')
      // The toll-free registration (filed with the client's own details, like Forte's), as Twilio answers it.
      if (r.verificationAt && r.verification && r.verification !== 'none') {
        feed(`nr:${r.id}:filed`, r.verificationAt, 'echo', `Filed texting verification for ${r.clientName}'s ${num}`, 'terminal')
      }
      if (r.verification === 'approved') {
        feed(`nr:${r.id}:approved`, r.verificationChangedAt ?? r.updatedAt, 'echo', `${r.clientName}'s ${num} is approved to text`, 'done')
      }
      if (r.verifyNote) {
        add('echo', { status: 'needs_you', task: clip(`Texting verification for ${r.clientName} is blocked: ${r.verifyNote}`), icon: 'alert', at: r.updatedAt })
        request(`nr:${r.id}:verify`, 'echo', 'stuck', `${r.clientName}'s texting verification can't be filed yet: ${r.verifyNote}`, r.updatedAt, r.clientId ? `/sites/${r.clientId}` : null)
        feed(`nr:${r.id}:verify:${r.updatedAt.getTime()}`, r.updatedAt, 'echo', clip(`Texting verification for ${r.clientName} is blocked: ${r.verifyNote}`, 140), 'needs_you')
      } else if (age(r.route === 'ghl' ? r.updatedAt : at) <= DONE_MS) {
        add('echo', { status: 'terminal', task: `Got ${num}${where} for ${r.clientName}`, icon: 'check', at: r.route === 'ghl' ? r.updatedAt : at })
      }
    } else if (r.status === 'failed' && age(r.updatedAt) <= SUBACCOUNT_OPEN_MS) {
      const why = r.detail ? `: ${clip(r.detail, 80)}` : ''
      add('echo', { status: 'error', task: clip(`Buying ${r.clientName}'s toll-free number failed${why}`), icon: 'error', at: r.updatedAt })
      request(`nr:${r.id}:failed`, 'echo', 'error', `Buying ${r.clientName}'s toll-free number failed${r.detail ? `: ${r.detail}` : ''}`, r.updatedAt, r.clientId ? `/sites/${r.clientId}` : null)
      feed(`nr:${r.id}:failed:${r.updatedAt.getTime()}`, r.updatedAt, 'echo', clip(`Buying ${r.clientName}'s toll-free number failed${why}`, 140), 'error')
    } else if (r.status === 'declined') {
      feed(`nr:${r.id}:declined`, at, 'echo', `Toll-free number for ${r.clientName} declined`, 'thinking')
    }
  }

  // GHL toll-free registrations on the move: queued, being filled or sent, sent.
  for (const g of input.ghlRegistrations ?? []) {
    if (g.running) {
      add('echo', { status: 'browsing', task: `${g.registration === 'approved' ? 'Sending' : 'Filling'} ${g.clientName}’s toll-free registration in GHL`, icon: 'globe', at: g.at })
    } else if (g.registration === 'queued' || g.registration === 'approved') {
      add('echo', { status: 'thinking', task: `${g.clientName}’s toll-free registration in GHL is next`, icon: 'dots', at: g.at })
    } else if (g.registration === 'submitted') {
      feed(`gr:${g.id}:sent`, g.at, 'echo', `Sent ${g.clientName}’s toll-free registration in GHL`, 'done')
      if (age(g.at) <= DONE_MS) add('echo', { status: 'terminal', task: `Sent ${g.clientName}’s toll-free registration in GHL`, icon: 'check', at: g.at })
    }
  }

  // Render monitor.
  const rm = input.render
  if (rm?.enabled) {
    if (rm.heartbeatFailures > 0) {
      add('sentinel', { status: 'error', task: `Hub health check failing (${rm.heartbeatFailures}x)`, icon: 'error', at: now })
      request('rm:health', 'sentinel', 'error', `The Hub's health check is failing (${rm.heartbeatFailures} times in a row)`, now)
    } else if (rm.openProblems > 0) {
      add('sentinel', { status: 'needs_you', task: `${rm.openProblems} log error pattern(s) being watched`, icon: 'alert', at: now })
      request('rm:logs', 'sentinel', 'stuck', `${rm.openProblems} error pattern${rm.openProblems === 1 ? '' : 's'} in the Hub's Render logs being watched`, now)
    }
    else add('sentinel', { status: 'thinking', task: 'Watching Render logs and health', icon: 'gear', at: rm.lastDigestAt ?? now })
    if (rm.lastDigestAt) feed(`rm:${rm.lastDigestAt.getTime()}`, rm.lastDigestAt, 'sentinel', 'Sent the Render log digest', 'thinking')
  }

  // Handoffs (stage bot -> next stage bot) feed Alfred too.
  const handoffs = deriveHandoffs(input.journeyEvents, now)

  const idleTask: Record<BotId, string> = {
    alfred: 'All quiet — nothing to coordinate',
    wren: 'Waiting for Whop signups',
    ivy: 'Waiting for onboarding forms',
    atlas: 'No sub-accounts to create or link',
    forge: 'No website builds in flight',
    echo: 'No A2P filings moving',
    tally: 'Nothing to check off',
    scout: 'No SEO runs right now',
    sentinel: rm ? 'Render monitor is off (RENDER_MONITOR_ENABLED)' : 'Render monitor has no state yet',
  }

  const bots: OfficeBot[] = ROSTER.filter((r) => r.id !== 'alfred').map((r) => {
    const best = pickCandidate(cands.get(r.id)!)
    return best
      ? { ...r, status: best.status, task: best.task, icon: best.icon, since: best.at.toISOString() }
      : { ...r, status: 'idle' as const, task: idleTask[r.id], icon: null, since: null }
  })

  // Alfred: orchestration summary over the others.
  const needs = bots.filter((b) => b.status === 'needs_you' || b.status === 'error')
  const recentHandoff = handoffs[0]
  const anyWorking = bots.some((b) => isWorking(b.status))
  let alfred: Omit<OfficeBot, keyof RosterEntry>
  if (recentHandoff) {
    const fromName = ROSTER.find((r) => r.id === recentHandoff.from)!.name
    const toName = ROSTER.find((r) => r.id === recentHandoff.to)!.name
    alfred = { status: 'browsing', task: `Coordinating ${fromName} → ${toName} for ${recentHandoff.clientName}`, icon: 'folder', since: recentHandoff.at }
  } else if (needs.length) {
    alfred = { status: 'thinking', task: `Triaging ${needs.length} item${needs.length === 1 ? '' : 's'} that need you`, icon: 'dots', since: now.toISOString() }
  } else if (anyWorking) {
    alfred = { status: 'thinking', task: 'Overseeing the pipeline', icon: 'dots', since: now.toISOString() }
  } else {
    alfred = { status: 'idle', task: idleTask.alfred, icon: null, since: null }
  }
  const all: OfficeBot[] = [{ ...ROSTER[0], ...alfred }, ...bots]
  for (const h of handoffs) {
    const fromName = ROSTER.find((r) => r.id === h.from)!.name
    const toName = ROSTER.find((r) => r.id === h.to)!.name
    feed(`ho:${h.id}`, new Date(h.at), 'alfred', `Handed ${h.clientName} from ${fromName} to ${toName}`, 'browsing')
  }

  activity.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
  const seen = new Set<string>()
  const dedup = activity.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)))

  return {
    generatedAt: now.toISOString(),
    demo: !!opts.demo,
    bots: all,
    activity: dedup.slice(0, opts.feedLimit ?? 50),
    handoffs,
    approvals,
    // Errors first, then newest; one row per item.
    requests: [...new Map(requests.map((r) => [r.id, r])).values()].sort((a, b) => (a.kind === b.kind ? b.at.localeCompare(a.at) : a.kind === 'error' ? -1 : 1)),
    counts: {
      working: all.filter((b) => isWorking(b.status)).length,
      idle: all.filter((b) => b.status === 'idle').length,
      needsYou: all.filter((b) => b.status === 'needs_you').length,
      error: all.filter((b) => b.status === 'error').length,
    },
  }
}
