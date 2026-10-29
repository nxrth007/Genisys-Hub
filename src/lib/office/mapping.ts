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
  { id: 'atlas', name: 'Atlas', role: 'CRM sub-accounts', color: '#34d399', source: 'Journey stage "subaccount", SubaccountMatchSuggestion' },
  { id: 'forge', name: 'Forge', role: 'Website build', color: '#fb923c', source: 'Journey stage "website"' },
  { id: 'echo', name: 'Echo', role: 'A2P registration', color: '#f472b6', source: 'Journey stage "a2p", HlA2p' },
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

export type OfficeInput = {
  journeyEvents: JourneyEventIn[]
  openStages: StageRowIn[]
  intakes: IntakeIn[]
  whopClaims: WhopClaimIn[]
  matchSuggestions: MatchSuggestionIn[]
  seoRuns: SeoRunIn[]
  a2p: A2pIn[]
  render: RenderMonitorIn
}

export const emptyInput = (): OfficeInput => ({
  journeyEvents: [],
  openStages: [],
  intakes: [],
  whopClaims: [],
  matchSuggestions: [],
  seoRuns: [],
  a2p: [],
  render: null,
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
export type OfficeState = {
  generatedAt: string
  demo: boolean
  bots: OfficeBot[]
  activity: OfficeActivity[]
  handoffs: OfficeHandoff[]
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
  if (review.length) {
    const newest = review.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a))
    add('atlas', {
      status: 'needs_you',
      task: review.length === 1 ? `Review sub-account match for ${newest.clientName}` : `${review.length} sub-account matches need review`,
      icon: 'alert',
      at: newest.updatedAt,
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
      if (age(at) <= ERROR_MS) add('scout', { status: 'error', task: clip(`SEO run failed for ${r.siteName}${why}`), icon: 'error', at })
      feed(`seo:${r.id}:fail`, at, 'scout', `SEO run failed for ${r.siteName}${why}`, 'error')
    } else if (r.status.startsWith('awaiting_')) {
      const at = r.finishedAt ?? r.updatedAt
      feed(`seo:${r.id}:${r.status}`, at, 'scout', `SEO run for ${r.siteName} is ${r.status.replace('_', ' ')}`, 'needs_you')
      if (r.status === 'awaiting_review') add('scout', { status: 'needs_you', task: `SEO drafts for ${r.siteName} await review`, icon: 'alert', at })
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

  // Render monitor.
  const rm = input.render
  if (rm?.enabled) {
    if (rm.heartbeatFailures > 0) add('sentinel', { status: 'error', task: `Hub health check failing (${rm.heartbeatFailures}x)`, icon: 'error', at: now })
    else if (rm.openProblems > 0) add('sentinel', { status: 'needs_you', task: `${rm.openProblems} log error pattern(s) being watched`, icon: 'alert', at: now })
    else add('sentinel', { status: 'thinking', task: 'Watching Render logs and health', icon: 'gear', at: rm.lastDigestAt ?? now })
    if (rm.lastDigestAt) feed(`rm:${rm.lastDigestAt.getTime()}`, rm.lastDigestAt, 'sentinel', 'Sent the Render log digest', 'thinking')
  }

  // Handoffs (stage bot -> next stage bot) feed Alfred too.
  const handoffs = deriveHandoffs(input.journeyEvents, now)

  const idleTask: Record<BotId, string> = {
    alfred: 'All quiet — nothing to coordinate',
    wren: 'Waiting for Whop signups',
    ivy: 'Waiting for onboarding forms',
    atlas: 'No sub-accounts to link',
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
    counts: {
      working: all.filter((b) => isWorking(b.status)).length,
      idle: all.filter((b) => b.status === 'idle').length,
      needsYou: all.filter((b) => b.status === 'needs_you').length,
      error: all.filter((b) => b.status === 'error').length,
    },
  }
}
