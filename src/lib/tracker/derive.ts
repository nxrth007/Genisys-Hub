/**
 * The client tracker, derived. Pure (no DB, no Stripe): every onboarding
 * step's state is read from facts the Hub already holds, so the Tracker page
 * says what is true instead of waiting for somebody to tick a box.
 *
 *   signup       their Stripe subscription (trial, active, past due, canceled);
 *                a client from before Stripe (GHL, Whop) shows it as not needed
 *   intake       the onboarding form came in
 *   subaccount   their Genisys OS sub-account (or a linked GHL one)
 *   website      the site link in Clients, else Forge's build in Lovable
 *   domain       a domain in their Genisys OS Domains, or the site's own
 *   number       their toll-free number (Genisys OS or GHL)
 *   texting      texting registration: toll-free verification, A2P, or GHL's
 *   automations  the kit workflows live in Genisys OS, or the GHL copy
 *   gbp          Google Business Profile
 *   seo          the weekly SEO engine
 *   qa           the final check: a person tests the site, the form, texting
 *                and booking, then marks it done (the journey's "qa" stage)
 *
 * Five steps can also be marked done by hand (the old sheet's columns): a hand
 * mark counts only where the Hub has no evidence of its own, and shows as such.
 * A Stripe sign-up with no client yet (no onboarding form under that email) is
 * a row too, built from Stripe alone (`stripeOnly`), so the team sees who to
 * text for onboarding. Every row says what to do next (`nextAction`).
 * src/lib/tracker/facts.ts gathers the facts; the rules live here so
 * tests/tracker-derive.test.mjs can run them without a database.
 */
import { domainStage, siteHost, siteHref, tollFreeStage } from '@/lib/site-status'
import { billingLabel, shortDate, type BillingState, type BillingSubscription, type BillingTone } from '@/lib/stripe-billing-plan'

export const TRACK_STEPS = ['signup', 'intake', 'subaccount', 'website', 'domain', 'number', 'texting', 'automations', 'gbp', 'seo', 'qa'] as const
export type TrackStep = (typeof TRACK_STEPS)[number]

/** The steps a client needs for the system to work, ending with the final check; the others are informational. */
export const CORE_STEPS: readonly TrackStep[] = ['signup', 'intake', 'subaccount', 'website', 'number', 'texting', 'automations', 'qa']

export const STEP_TITLE: Record<TrackStep, string> = {
  signup: 'Stripe',
  intake: 'Onboarding form',
  subaccount: 'Sub-account',
  website: 'Website',
  domain: 'Domain',
  number: 'Phone number',
  texting: 'Texting',
  automations: 'Automations',
  gbp: 'Google profile',
  seo: 'SEO',
  qa: 'QA',
}

/** What "done" means, for the legend and the cell details. */
export const STEP_MEANS: Record<TrackStep, string> = {
  signup: 'Their Stripe subscription: a trial or an active plan is done; past due or canceled needs a person. A client from before Stripe (GHL, Whop) shows a dash.',
  intake: 'The onboarding form came in and is linked to the client.',
  subaccount: 'Their Genisys OS sub-account exists (or a GHL sub-account is linked).',
  website: 'The site link is in Clients, or Forge published the site.',
  domain: 'A domain in their Genisys OS Domains, or the site is on their own domain.',
  number: 'A toll-free number bought for them, in Genisys OS or in GHL.',
  texting: 'Toll-free texting verification approved, A2P approved, or GHL’s registration done.',
  automations: 'The kit workflows are live in Genisys OS, or the GHL automations were set up.',
  gbp: 'Their Google Business Profile is verified or already existed.',
  seo: 'The weekly SEO engine runs for their site.',
  qa: 'A person tested the site, the form, texting and booking, then marked the final check done.',
}

/** The words a client sees on their status link, and what to tell them is next. */
export const STEP_PUBLIC: Record<TrackStep, { label: string; next: string }> = {
  signup: { label: 'Sign-up', next: 'Complete your sign-up.' },
  intake: { label: 'Onboarding form', next: 'Fill in the onboarding form.' },
  subaccount: { label: 'Your account', next: 'Our team is setting up your account.' },
  website: { label: 'Website', next: 'Our team is building your website.' },
  domain: { label: 'Domain', next: 'Our team is sorting out your domain.' },
  number: { label: 'Phone number', next: 'Our team is setting up your phone number.' },
  texting: { label: 'Texting registration', next: 'Your texting registration is being reviewed by the carriers.' },
  automations: { label: 'Automations', next: 'Our team is setting up your automations.' },
  gbp: { label: 'Google profile', next: 'Your Google Business Profile is being set up.' },
  seo: { label: 'SEO', next: 'SEO starts once your site is live.' },
  qa: { label: 'Final check', next: 'Our team is running a final check of everything.' },
}

export type StepState = 'done' | 'in_progress' | 'blocked' | 'pending' | 'not_needed' | 'none'
export const STEP_STATES: readonly StepState[] = ['done', 'in_progress', 'blocked', 'pending', 'not_needed', 'none']
export function isStepState(v: unknown): v is StepState {
  return typeof v === 'string' && (STEP_STATES as readonly string[]).includes(v)
}
export const STATE_WORD: Record<StepState, string> = { done: 'Done', in_progress: 'In progress', blocked: 'Blocked', pending: 'Pending', not_needed: 'Not needed', none: 'No record' }

export type StepView = {
  state: StepState
  /** The evidence, in a few words ("Trial · first charge Dec 16", "(855) 609-0482: bought and verified"). */
  note: string | null
  /** When the evidence happened, ISO; null when the Hub only knows the state. */
  at: string | null
  /** Where to act or look (a Hub page, or Stripe). */
  href: string | null
  /** Done because somebody marked it so, with no evidence of the Hub's own. */
  byHand: boolean
  /** Nothing on record at all: the note only says so (the client page shows a dash). */
  empty?: boolean
}

/** The steps that can be marked done by hand, and their ClientTracker column. */
export const MANUAL_FIELDS = {
  signup: 'signupStatus',
  intake: 'intakeStatus',
  automations: 'automationsStatus',
  texting: 'a2pStatus',
  number: 'tollFreeStatus',
} as const satisfies Partial<Record<TrackStep, string>>
export type ManualStep = keyof typeof MANUAL_FIELDS
export const MANUAL_STEPS = Object.keys(MANUAL_FIELDS) as ManualStep[]
export function isManualStep(v: unknown): v is ManualStep {
  return typeof v === 'string' && v in MANUAL_FIELDS
}
/** The sheet's step ids (src/lib/tracker/columns.ts) for the same five columns. */
export const LEGACY_STEP: Record<string, ManualStep> = { signup: 'signup', intake: 'intake', automations: 'automations', a2p: 'texting', tollfree: 'number' }
export function isTrackStep(v: unknown): v is TrackStep {
  return typeof v === 'string' && (TRACK_STEPS as readonly string[]).includes(v)
}
/** A step id as a request names it: the new ids, or the sheet's old ones. */
export function readStep(v: unknown): TrackStep | null {
  if (isTrackStep(v)) return v
  return typeof v === 'string' && v in LEGACY_STEP ? LEGACY_STEP[v] : null
}

/** The steps a person can mark on the client's page: the sheet's five, and the final check. */
export type HandStep = ManualStep | 'qa'
export const HAND_STEPS: readonly HandStep[] = [...MANUAL_STEPS, 'qa']
export function isHandStep(v: unknown): v is HandStep {
  return v === 'qa' || isManualStep(v)
}

/** The client page: three milestones across the top, every other step in the fulfillment list. */
export const MILESTONES: readonly TrackStep[] = ['signup', 'intake', 'website']
export const FULFILLMENT: readonly TrackStep[] = ['subaccount', 'domain', 'number', 'texting', 'automations', 'gbp', 'seo', 'qa']

export type ManualMarks = Record<ManualStep, 'done' | 'pending'> & { updatedAt: string | null; source: string | null }

export type ClientFacts = {
  id: string
  name: string
  /** The business as the onboarding form named it, when it did. */
  business: string | null
  /** The person. */
  person: string | null
  email: string | null
  color: string
  lifecycle: string
  archived: boolean
  createdAt: string
  intake: { receivedAt: string } | null
  /** Their Stripe standing; null = no subscription for any of their customers. */
  billing: {
    state: BillingState
    subscription: BillingSubscription | null
    created: string | null
    href: string | null
  } | null
  /** False when Stripe couldn't be read this time (no key, Stripe down). */
  billingKnown: boolean
  /** Journey stage rows the pipeline wrote (src/lib/client-journey.ts). */
  journey: Partial<Record<'signup' | 'intake' | 'subaccount' | 'website' | 'a2p' | 'qa', { status: string; note: string | null; updatedAt: string | null }>>
  hl: {
    id: string
    createdAt: string
    archived: boolean
    workflows: { published: number; total: number }
    numbers: { number: string; kind: string; verificationStatus: string; verificationNote: string | null; verificationAt: string | null; createdAt: string }[]
    domains: { name: string; origin: string; status: string; createdAt: string }[]
    a2p: { stage: string; campaignStatus: string | null; filedAt: string | null; approvedAt: string | null; updatedAt: string } | null
  } | null
  ghl: {
    linked: boolean
    /** One of the clients Alex keeps on GHL: A2P or toll-free verified there. */
    staysOnGhl: boolean
    censusNumbers: { number: string; tollFree: boolean; verificationRequired: boolean }[]
    censusAt: string | null
    /** GHL's toll-free registration for a number bought there (src/lib/ghl-number). */
    registration: string | null
    customize: { status: string; finishedAt: string | null; updatedAt: string } | null
  }
  siteUrl: string | null
  siteLiveAt: string | null
  /** Forge's website build (src/lib/hl/site-request.ts); null before it was asked. */
  siteBuild: { status: string; label: string; liveUrl: string | null; publishedAt: string | null; updatedAt: string } | null
  domainQuestion: { status: string; name: string | null; detail: string | null } | null
  numberRequest: { status: string; route: string; number: string | null; detail: string | null; updatedAt: string } | null
  automationCopy: { done: number; total: number; updatedAt: string | null }
  gbp: { status: string | null; profileUrl: string | null } | null
  seo: { mode: string; enabled: boolean; archived: boolean; lastRunAt: string | null; lastScore: number | null } | null
  manual: ManualMarks
  /** Set for a Stripe sign-up with no client in the Hub (no onboarding form under that email yet): `id` is the Stripe customer id. */
  stripeOnly?: { suggestion: { clientId: string; name: string } | null; phone: string | null } | null
}

export const NO_MARKS: ManualMarks = { signup: 'pending', intake: 'pending', automations: 'pending', texting: 'pending', number: 'pending', updatedAt: null, source: null }

const view = (state: StepState, note: string | null = null, at: string | null = null, href: string | null = null): StepView => ({ state, note, at, href, byHand: false })
/** No evidence at all: the note says so, and nothing else is known. */
const nothing = (state: StepState, note: string, href: string | null = null): StepView => ({ state, note, at: null, href, byHand: false, empty: true })

const phone = (n: string): string => {
  const d = n.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : n
}

const latest = (...dates: (string | null | undefined)[]): string | null => {
  let best: string | null = null
  for (const d of dates) {
    if (!d) continue
    if (!best || new Date(d).getTime() > new Date(best).getTime()) best = d
  }
  return best
}

const OWN_HOST = /(^|\.)(lovable\.app|lovableproject\.com|onrender\.com)$/i

// ---- one rule per step --------------------------------------------------------------------

function signup(f: ClientFacts): StepView {
  const b = f.billing
  if (b && b.state !== 'none') {
    const w = billingLabel({ state: b.state, subscription: b.subscription })
    const note = w.detail ? `${w.text} · ${w.detail}` : w.text
    if (b.state === 'problem') return view('blocked', note, b.created, b.href)
    if (b.state === 'canceled') return view('blocked', note, b.subscription?.endedAt ?? b.subscription?.canceledAt ?? b.created, b.href)
    return view('done', note, b.created, b.href)
  }
  const j = f.journey.signup
  // Stripe couldn't be read this time: lean on the other evidence so an outage doesn't stall everyone here.
  if (!f.billingKnown) {
    if (j?.status === 'done') return view('done', `Stripe couldn’t be read · ${j.note ?? 'signed up'}`, j.updatedAt)
    if (f.intake) return view('done', 'Stripe couldn’t be read · the onboarding form implies a sign-up', f.intake.receivedAt)
    return view('none', 'Stripe couldn’t be read, and nothing else on record')
  }
  // Read, and not in Stripe: a client from before Stripe (GHL, Whop), or one whose Stripe email the Hub doesn't hold.
  if (j?.status === 'done') return view('not_needed', `Not in Stripe · ${j.note ?? 'signed up before Stripe'}`, j.updatedAt)
  if (f.intake) return view('not_needed', 'Not in Stripe: from before Stripe, or signed up under another email', f.intake.receivedAt)
  if (j?.status === 'blocked') return view('blocked', j.note, j.updatedAt)
  return nothing('pending', 'Not in Stripe')
}

function intake(f: ClientFacts): StepView {
  if (f.intake) return view('done', 'Onboarding form received', f.intake.receivedAt)
  const look = f.stripeOnly?.suggestion
  if (look) return view('pending', `No onboarding form under this email; the name looks like ${look.name}`)
  const j = f.journey.intake
  if (j?.status === 'blocked') return view('blocked', j.note, j.updatedAt)
  return nothing('pending', 'No onboarding form yet')
}

function subaccount(f: ClientFacts): StepView {
  if (f.hl && !f.hl.archived) return view('done', 'Genisys OS sub-account', f.hl.createdAt, `/genisys-os/${f.hl.id}`)
  if (f.ghl.linked) return view('done', 'GHL sub-account linked', f.journey.subaccount?.updatedAt ?? null, `/clients/${f.id}/ghl`)
  if (f.hl?.archived) return view('blocked', 'Genisys OS sub-account archived', null, `/genisys-os/${f.hl.id}`)
  const j = f.journey.subaccount
  if (j?.status === 'blocked') return view('blocked', j.note, j.updatedAt)
  if (j?.status === 'in_progress') return view('in_progress', j.note, j.updatedAt)
  return nothing('pending', 'No sub-account yet')
}

const LIVE_BUILD = new Set(['published', 'connecting', 'connected'])
const WORKING_BUILD = new Set(['filling', 'copying', 'sending', 'building', 'waiting_on_lovable', 'built', 'publishing'])

function website(f: ClientFacts): StepView {
  if (f.siteUrl?.trim()) return view('done', `Live at ${siteHost(f.siteUrl)}`, f.siteLiveAt, siteHref(f.siteUrl.trim()))
  const b = f.siteBuild
  if (b) {
    if (LIVE_BUILD.has(b.status)) return view('done', b.liveUrl ? `${b.label}: ${siteHost(b.liveUrl)}` : b.label, b.publishedAt ?? b.updatedAt, b.liveUrl ? siteHref(b.liveUrl) : `/sites/${f.id}`)
    if (b.status === 'failed') return view('blocked', b.label, b.updatedAt, `/sites/${f.id}`)
    if (WORKING_BUILD.has(b.status)) return view('in_progress', b.label, b.updatedAt, `/sites/${f.id}`)
    if (b.status === 'awaiting_approval' || b.status === 'declined' || b.status === 'held') return view('pending', b.label, b.updatedAt, `/sites/${f.id}`)
  }
  const j = f.journey.website
  if (j?.status === 'done') return view('done', j.note ?? 'Website done', j.updatedAt, `/sites/${f.id}`)
  if (j?.status === 'blocked') return view('blocked', j.note, j.updatedAt, `/sites/${f.id}`)
  if (j?.status === 'in_progress') return view('in_progress', j.note ?? 'Being built', j.updatedAt, `/sites/${f.id}`)
  return nothing('pending', 'Needs a site', `/sites/${f.id}`)
}

function domain(f: ClientFacts): StepView {
  const own = siteHost(f.siteUrl)
  const r = domainStage({
    domains: f.hl?.domains ?? [],
    question: f.domainQuestion,
    siteHost: own && !OWN_HOST.test(own) ? own : null,
  })
  const held = (f.hl?.domains ?? []).find((d) => d.status === 'active') ?? (f.hl?.domains ?? [])[0]
  const state: StepState = r.status === 'done' ? 'done' : r.status === 'in_progress' ? 'in_progress' : r.status === 'blocked' ? 'blocked' : 'pending'
  if (state === 'pending' && !r.note && !f.hl) return nothing('none', 'No domain on record', `/sites/${f.id}`)
  return view(state, r.note, held?.createdAt ?? null, `/sites/${f.id}`)
}

function number(f: ClientFacts): StepView {
  const numbers = f.hl && !f.hl.archived ? f.hl.numbers : []
  const tollFree = numbers.find((n) => n.kind === 'toll_free') ?? null
  const ghlBought = !tollFree && f.numberRequest?.route === 'ghl' && f.numberRequest.status === 'bought' && f.numberRequest.number ? f.numberRequest : null
  // A number already in their GHL sub-account (the daily read), when the Hub bought none.
  if (!tollFree && !ghlBought && f.ghl.linked && f.ghl.censusNumbers.length) {
    const n = f.ghl.censusNumbers.find((x) => x.tollFree) ?? f.ghl.censusNumbers[0]
    if (f.ghl.staysOnGhl || !n.verificationRequired) return view('done', `${phone(n.number)} in GHL`, f.ghl.censusAt, `/clients/${f.id}/ghl`)
    return view('in_progress', `${phone(n.number)} in GHL: Verification Required, it can’t text yet`, f.ghl.censusAt, `/clients/${f.id}/ghl`)
  }
  // One of the clients Alex keeps on GHL: verified there on a GHL number, read or not.
  if (!tollFree && !ghlBought && f.ghl.linked && f.ghl.staysOnGhl) return view('done', 'Number in GHL (stays on GHL)', f.ghl.censusAt, `/clients/${f.id}/ghl`)
  const r = tollFreeStage({
    number: tollFree ? { number: tollFree.number, verificationStatus: tollFree.verificationStatus, verificationNote: tollFree.verificationNote } : null,
    ghl: ghlBought ? { number: ghlBought.number!, registration: f.ghl.registration } : null,
    request: f.numberRequest ? { status: f.numberRequest.status, detail: f.numberRequest.detail } : null,
    ghlLinked: f.ghl.linked,
    ghlCantText: false,
    siteLive: !!f.siteUrl?.trim(),
  })
  // A number bought is the step done; its verification is the texting step.
  const state: StepState = tollFree || ghlBought ? 'done' : r.status === 'blocked' ? 'blocked' : r.status === 'in_progress' ? 'in_progress' : r.status === 'none' ? 'none' : 'pending'
  const at = tollFree?.createdAt ?? ghlBought?.updatedAt ?? f.numberRequest?.updatedAt ?? null
  const note = tollFree ? `${phone(tollFree.number)}: bought${tollFree.verificationStatus === 'approved' ? ' and verified' : ''}` : ghlBought ? `${phone(ghlBought.number!)} in GHL: bought` : r.note
  return view(state, note, at, f.hl && !f.hl.archived ? `/sites/${f.id}` : f.ghl.linked ? `/clients/${f.id}/ghl` : null)
}

const GHL_REG_WORKING = new Set(['waiting_site', 'queued', 'review', 'submitted'])
const A2P_WORKING = new Set(['profile', 'brand', 'otp', 'campaign'])

function texting(f: ClientFacts): StepView {
  const numbers = f.hl && !f.hl.archived ? f.hl.numbers : []
  const tollFree = numbers.find((n) => n.kind === 'toll_free') ?? null
  const href = f.hl && !f.hl.archived ? `/sites/${f.id}` : f.ghl.linked ? `/clients/${f.id}/a2p` : null
  if (tollFree) {
    const n = phone(tollFree.number)
    const v = tollFree.verificationStatus
    if (v === 'approved') return view('done', `${n}: toll-free texting approved`, tollFree.verificationAt, href)
    if (v === 'rejected') return view('blocked', `${n}: verification rejected${tollFree.verificationNote ? ` (${tollFree.verificationNote})` : ''}`, tollFree.verificationAt, href)
    if (v === 'pending' || v === 'in_review') return view('in_progress', `${n}: Twilio is reviewing the verification`, tollFree.verificationAt, href)
  }
  const a = f.hl && !f.hl.archived ? f.hl.a2p : null
  if (a) {
    if (a.stage === 'approved') return view('done', 'A2P approved: texts go out', a.approvedAt ?? a.updatedAt, href)
    if (a.stage === 'failed') return view('blocked', `A2P rejected${a.campaignStatus ? ` (${a.campaignStatus})` : ''}`, a.updatedAt, href)
    if (A2P_WORKING.has(a.stage)) return view('in_progress', a.stage === 'otp' ? 'A2P: waiting for the owner’s YES text' : `A2P filed: ${a.stage === 'campaign' ? 'carriers are reviewing the campaign' : 'registering the brand'}`, a.filedAt ?? a.updatedAt, href)
  }
  if (f.ghl.linked && f.ghl.staysOnGhl) return view('done', 'Verified in GHL (stays on GHL)', null, `/clients/${f.id}/a2p`)
  const reg = f.ghl.registration
  if (reg === 'approved') return view('done', 'GHL toll-free registration approved', null, `/clients/${f.id}/toll-free`)
  if (reg && GHL_REG_WORKING.has(reg)) return view('in_progress', `GHL toll-free registration ${reg === 'submitted' ? 'is with GHL' : reg === 'review' ? 'waits on a review in the Office' : reg === 'queued' ? 'is queued' : 'waits for the live site'}`, null, `/clients/${f.id}/toll-free`)
  if (reg === 'held' || reg === 'needs_human') return view('blocked', `GHL toll-free registration ${reg === 'held' ? 'is on hold' : 'needs a person'}`, null, `/clients/${f.id}/toll-free`)
  const j = f.journey.a2p
  if (j?.status === 'done') return view('done', j.note ?? 'Texting registration done', j.updatedAt, href)
  if (j?.status === 'blocked') return view('blocked', j.note, j.updatedAt, href)
  if (j?.status === 'in_progress') return view('in_progress', j.note ?? 'Texting registration in progress', j.updatedAt, href)
  if (tollFree) return view('pending', f.siteUrl?.trim() ? `${phone(tollFree.number)}: verification not filed yet` : `${phone(tollFree.number)}: verification is filed once the site is live`, tollFree.createdAt, href)
  if (f.ghl.linked && f.ghl.censusNumbers.length) {
    const n = f.ghl.censusNumbers.find((x) => x.tollFree) ?? f.ghl.censusNumbers[0]
    return n.verificationRequired ? view('pending', `${phone(n.number)} in GHL: Verification Required`, f.ghl.censusAt, `/clients/${f.id}/toll-free`) : view('done', `${phone(n.number)} in GHL can text`, f.ghl.censusAt, `/clients/${f.id}/ghl`)
  }
  return nothing('pending', 'No texting registration yet', href)
}

const CUSTOMIZE_DONE = new Set(['done', 'saved'])
const CUSTOMIZE_WORKING = new Set(['queued', 'running', 'rehearsed'])
const CUSTOMIZE_STUCK = new Set(['needs_human', 'held', 'blocked', 'failed'])

function automations(f: ClientFacts): StepView {
  if (f.hl && !f.hl.archived) {
    const w = f.hl.workflows
    if (w.published > 0) return view('done', `${w.published} workflow${w.published === 1 ? '' : 's'} live in Genisys OS`, f.hl.createdAt, `/genisys-os/${f.hl.id}`)
    return view('in_progress', 'Sub-account made, kit workflows not published yet', f.hl.createdAt, `/genisys-os/${f.hl.id}`)
  }
  const c = f.ghl.customize
  if (c && CUSTOMIZE_DONE.has(c.status)) return view('done', 'Lead workflows customized in GHL', c.finishedAt ?? c.updatedAt, `/automation-copy/${f.id}`)
  const ac = f.automationCopy
  if (ac.total > 0 && ac.done >= ac.total) return view('done', 'Automation Copy board marked completed', ac.updatedAt, `/automation-copy/${f.id}`)
  if (c && CUSTOMIZE_STUCK.has(c.status)) return view('blocked', `GHL workflow job ${c.status.replace(/_/g, ' ')}`, c.updatedAt, `/automation-copy/${f.id}`)
  if (c && CUSTOMIZE_WORKING.has(c.status)) return view('in_progress', 'Workflow AI is putting their copy into GHL', c.updatedAt, `/automation-copy/${f.id}`)
  if (ac.done > 0) return view('in_progress', `${ac.done} of ${ac.total} automations ticked on the board`, ac.updatedAt, `/automation-copy/${f.id}`)
  return nothing('pending', 'Not set up yet', `/automation-copy/${f.id}`)
}

function gbp(f: ClientFacts): StepView {
  const g = f.gbp
  const href = `/clients/${f.id}/gbp`
  if (!g || !g.status) return nothing('none', 'No answer about a Google profile yet', href)
  switch (g.status) {
    case 'verified':
      return view('done', 'Profile verified', null, g.profileUrl ?? href)
    case 'has_profile':
      return view('done', 'Already had a Google profile', null, g.profileUrl ?? href)
    case 'existing':
      return view('in_progress', 'An existing listing was found; claim it', null, href)
    case 'created':
      return view('in_progress', 'Profile created, verification pending', null, href)
    case 'verifying':
      return view('in_progress', 'Waiting on the owner to finish and verify it', null, href)
    case 'needed':
      return view('pending', 'Needs a Google profile', null, href)
    default:
      return view('none', g.status, null, href)
  }
}

function seo(f: ClientFacts): StepView {
  const s = f.seo
  if (!s || s.archived) return nothing('none', 'No SEO site', '/seo')
  if (!s.enabled) return view('pending', 'SEO engine switched off', s.lastRunAt, '/seo')
  const run = s.lastRunAt ? ` · last run ${shortDate(s.lastRunAt)}` : ''
  const score = s.lastScore != null ? ` · score ${s.lastScore}` : ''
  if (s.mode === 'autopilot') return view('done', `Weekly engine on${run}${score}`, s.lastRunAt, '/seo')
  if (s.mode === 'review') return view('in_progress', `Review mode: posts wait for approval${run}`, s.lastRunAt, '/seo')
  return view('in_progress', `Audit mode${run}${score}`, s.lastRunAt, '/seo')
}

function qa(f: ClientFacts): StepView {
  const j = f.journey.qa
  if (j?.status === 'done') return view('done', j.note ? `Final check passed: ${j.note}` : 'Final check passed', j.updatedAt)
  if (j?.status === 'blocked') return view('blocked', j.note ?? 'The final check found a problem', j.updatedAt)
  if (j?.status === 'in_progress') return view('in_progress', j.note ?? 'Final check under way', j.updatedAt)
  return nothing('pending', 'Not checked yet')
}

const RULES: Record<TrackStep, (f: ClientFacts) => StepView> = { signup, intake, subaccount, website, domain, number, texting, automations, gbp, seo, qa }

/** Every step for one client: the Hub's evidence first, a hand mark only where there is none. */
export function deriveSteps(f: ClientFacts): Record<TrackStep, StepView> {
  const out = {} as Record<TrackStep, StepView>
  for (const s of TRACK_STEPS) {
    let v = RULES[s](f)
    if ((v.state === 'pending' || v.state === 'none') && isManualStep(s) && f.manual[s] === 'done') {
      v = { state: 'done', note: 'Marked done by hand', at: f.manual.updatedAt, href: v.href, byHand: true }
    }
    // A Stripe sign-up with no client yet has no Hub pages to open; Stripe's own link stays.
    if (f.stripeOnly && v.href?.startsWith('/')) v = { ...v, href: null }
    out[s] = v
  }
  return out
}

/** The first core step that isn't done; null once they all are. */
export function currentStep(steps: Record<TrackStep, StepView>): TrackStep | null {
  return CORE_STEPS.find((s) => steps[s].state !== 'done' && steps[s].state !== 'not_needed') ?? null
}

/** When anything last happened for the client: the newest evidence date, else when the client was made. */
export function lastChangeAt(steps: Record<TrackStep, StepView>, createdAt: string): string {
  return latest(...TRACK_STEPS.map((s) => steps[s].at)) ?? createdAt
}

export const STUCK_AFTER_DAYS = 7

export function daysSince(iso: string, now = Date.now()): number {
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? 0 : Math.max(0, Math.floor((now - t) / 86_400_000))
}

/** "Torrence" from "Torrence Surles"; null when there's no person or the first word isn't a name. */
export function firstName(person: string | null | undefined): string | null {
  const w = (person ?? '').trim().split(/\s+/)[0] ?? ''
  return /^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’.-]*$/.test(w) ? w : null
}

/** What the team does next, in their words. `act`: a person on the team has to do it; `wait`: someone else has it. */
export type NextAction = { kind: 'act' | 'wait' | 'done'; text: string; step: TrackStep | null }

const REGISTRATION_STUCK = new Set(['held', 'needs_human'])

/** The next action for the client's current step (the first core step not done). */
export function nextAction(f: ClientFacts, steps: Record<TrackStep, StepView>, current: TrackStep | null): NextAction {
  if (!current) return { kind: 'done', text: 'Done', step: null }
  const v = steps[current]
  const them = firstName(f.person) ?? 'them'
  const act = (text: string): NextAction => ({ kind: 'act', text, step: current })
  const wait = (text: string): NextAction => ({ kind: 'wait', text, step: current })
  switch (current) {
    case 'signup': {
      const b = f.billing
      if (b?.state === 'problem') return act(`Follow up with ${them}: ${billingLabel({ state: 'problem', subscription: b.subscription }).text.split(' · ')[0].toLowerCase()}`)
      if (b?.state === 'canceled') return act('Canceled in Stripe')
      if (v.state === 'none') return wait('Stripe couldn’t be read')
      return act(`Get ${them} signed up`)
    }
    case 'intake': {
      const look = f.stripeOnly?.suggestion
      if (look) return act(`Same as ${look.name}?`)
      return act(`Text ${them} for onboarding`)
    }
    case 'subaccount':
      if (v.state === 'in_progress') return wait('Sub-account being made')
      if (v.state === 'blocked') return act('Sub-account is archived')
      return act('Create their sub-account')
    case 'website': {
      const b = f.siteBuild?.status
      if (v.state === 'blocked') return act(b === 'failed' ? 'Site build didn’t finish' : 'Site is blocked')
      if (b === 'awaiting_approval') return act('Approve the site in the Office')
      if (b === 'built' || b === 'held') return act('Publish the site')
      if (b === 'waiting_on_lovable') return act('Answer Lovable’s question')
      if (v.state === 'in_progress') return wait('Site being built')
      return act('Need to create site')
    }
    case 'number': {
      const r = f.numberRequest?.status
      if (r === 'awaiting_approval') return act('Answer Echo’s number question')
      if (r === 'awaiting_identity') return act(`Get ${them} through GHL’s ID check`)
      if (v.state === 'blocked') return act('Number purchase failed')
      if (v.state === 'in_progress' && f.ghl.censusNumbers.length) return act('Verify their GHL number')
      if (v.state === 'in_progress') return wait('Buying their number')
      if (v.state === 'none') return act('Check their GHL number')
      return act('Get their phone number')
    }
    case 'texting':
      if (v.state === 'blocked') return act(REGISTRATION_STUCK.has(f.ghl.registration ?? '') ? 'Texting registration needs a person' : 'Texting registration rejected')
      if (v.state === 'in_progress') {
        if (f.hl?.a2p?.stage === 'otp') return act(`Ask ${them} to reply YES`)
        if (f.ghl.registration === 'review') return act('Review the GHL filing in the Office')
        if (f.ghl.registration === 'waiting_site') return wait('Texting waits for the live site')
        return wait('Texting under review')
      }
      return act('File texting registration')
    case 'automations':
      if (v.state === 'blocked') return act('Automations need a person')
      if (v.state === 'in_progress' && f.hl && !f.hl.archived) return act('Publish their automations')
      if (v.state === 'in_progress' && f.ghl.customize && CUSTOMIZE_WORKING.has(f.ghl.customize.status)) return wait('Automations being set up')
      if (v.state === 'in_progress') return act('Finish their automations')
      return act('Set up automations')
    case 'qa':
      if (v.state === 'blocked') return act('Fix what the final check found')
      if (v.state === 'in_progress') return wait('Final check under way')
      return act('Run the final check')
    default:
      return act(STEP_TITLE[current])
  }
}

/** When they signed up: their Stripe subscription, else the onboarding form, else when the Hub made the client. */
export function signedUpAt(f: Pick<ClientFacts, 'billing' | 'intake' | 'createdAt'>): string {
  return f.billing?.created ?? f.intake?.receivedAt ?? f.createdAt
}

export type TrackerRow = {
  clientId: string
  clientName: string
  business: string | null
  person: string | null
  email: string | null
  color: string
  lifecycle: string
  archived: boolean
  createdAt: string
  steps: Record<TrackStep, StepView>
  current: TrackStep | null
  /** Every core step is done. */
  complete: boolean
  /** A core step is blocked. */
  blocked: boolean
  lastChangeAt: string
  /** Days since anything happened, when the client still has a step to go. */
  stuckDays: number | null
  stuck: boolean
  billing: { state: BillingState; text: string; detail: string | null; tone: BillingTone } | null
  manual: ManualMarks
  hasRow: boolean
  sheetRow: number | null
  /** When they signed up (Stripe, else the onboarding form, else the client record), ISO. */
  signedUpAt: string
  /** What to do next, in the team's words. */
  next: NextAction
  /** A Stripe sign-up with no client in the Hub yet: `clientId` is the Stripe customer id. */
  stripeOnly: boolean
  /** For a Stripe-only row: a client whose name looks like this customer's, for a person to check. */
  suggestion: { clientId: string; name: string } | null
}

/** On the roster: not archived, churned or denied — the clients whose set-up matters. */
export const onRoster = (f: Pick<ClientFacts, 'archived' | 'lifecycle'>): boolean => !f.archived && f.lifecycle !== 'churned' && f.lifecycle !== 'denied'

export function trackerRow(f: ClientFacts, o: { hasRow: boolean; sheetRow: number | null }, now = Date.now()): TrackerRow {
  const steps = deriveSteps(f)
  const current = currentStep(steps)
  const last = lastChangeAt(steps, f.createdAt)
  const stuckDays = current && onRoster(f) ? daysSince(last, now) : null
  const b = f.billing
  const w = b ? billingLabel({ state: b.state, subscription: b.subscription }) : f.billingKnown ? billingLabel(null) : null
  return {
    clientId: f.id,
    clientName: f.name,
    business: f.business,
    person: f.person,
    email: f.email,
    color: f.color,
    lifecycle: f.lifecycle,
    archived: f.archived,
    createdAt: f.createdAt,
    steps,
    current,
    complete: current === null,
    blocked: CORE_STEPS.some((s) => steps[s].state === 'blocked'),
    lastChangeAt: last,
    stuckDays,
    stuck: stuckDays != null && stuckDays >= STUCK_AFTER_DAYS,
    billing: w ? { state: b?.state ?? 'none', ...w } : null,
    manual: f.manual,
    hasRow: o.hasRow,
    sheetRow: o.sheetRow,
    signedUpAt: signedUpAt(f),
    next: nextAction(f, steps, current),
    stripeOnly: !!f.stripeOnly,
    suggestion: f.stripeOnly?.suggestion ?? null,
  }
}

export type TrackerSummary = {
  roster: number
  complete: number
  stuck: number
  blocked: number
  /** The next action is the team's to do. */
  act: number
  /** The next action waits on someone else (Twilio, the carriers, Lovable). */
  wait: number
  /** Clients per current step (roster only). */
  byStep: Record<TrackStep, number>
  /** Per step, how many roster clients are in each state. */
  states: Record<TrackStep, Record<StepState, number>>
}

export function summarizeTracker(rows: TrackerRow[]): TrackerSummary {
  const roster = rows.filter(onRoster)
  const byStep = Object.fromEntries(TRACK_STEPS.map((s) => [s, 0])) as Record<TrackStep, number>
  const states = Object.fromEntries(TRACK_STEPS.map((s) => [s, Object.fromEntries(STEP_STATES.map((x) => [x, 0]))])) as Record<TrackStep, Record<StepState, number>>
  for (const r of roster) {
    if (r.current) byStep[r.current]++
    for (const s of TRACK_STEPS) states[s][r.steps[s].state]++
  }
  return {
    roster: roster.length,
    complete: roster.filter((r) => r.complete).length,
    stuck: roster.filter((r) => r.stuck).length,
    blocked: roster.filter((r) => r.blocked).length,
    act: roster.filter((r) => r.next.kind === 'act').length,
    wait: roster.filter((r) => r.next.kind === 'wait').length,
    byStep,
    states,
  }
}

export const SHOWS = ['all', 'act', 'wait', 'working', 'stuck', 'blocked', 'complete'] as const
export type Show = (typeof SHOWS)[number]
/** A `show` filter as a request names it; anything else is everyone. */
export function readShow(v: unknown): Show {
  return typeof v === 'string' && (SHOWS as readonly string[]).includes(v) ? (v as Show) : 'all'
}

export type RowFilter = {
  q?: string
  step?: TrackStep
  state?: StepState
  show?: Show
  stage?: TrackStep
  /** Only clients Stripe knows, in any subscription state ("In Stripe only"). */
  stripe?: boolean
}

/** Stripe knows this client, in any subscription state. When Stripe couldn't be read nobody is hidden. */
export const inStripe = (r: Pick<TrackerRow, 'billing'>): boolean => !r.billing || r.billing.state !== 'none'

export function filterRows(rows: TrackerRow[], o: RowFilter): TrackerRow[] {
  const q = (o.q ?? '').trim().toLowerCase()
  return rows.filter((r) => {
    if (o.step && o.state && r.steps[o.step].state !== o.state) return false
    if (o.stripe && !inStripe(r)) return false
    if (o.stage && r.current !== o.stage) return false
    if (o.show === 'stuck' && !r.stuck) return false
    if (o.show === 'blocked' && !r.blocked) return false
    if (o.show === 'complete' && !r.complete) return false
    if (o.show === 'working' && (r.complete || !onRoster(r))) return false
    if (o.show === 'act' && (r.next.kind !== 'act' || !onRoster(r))) return false
    if (o.show === 'wait' && (r.next.kind !== 'wait' || !onRoster(r))) return false
    if (!q) return true
    return [r.clientName, r.business, r.person, r.email].some((v) => (v ?? '').toLowerCase().includes(q))
  })
}

/** Newest sign-up first, the way Stripe lists its customers. */
export function sortRows(rows: TrackerRow[]): TrackerRow[] {
  const at = (r: TrackerRow) => {
    const t = Date.parse(r.signedUpAt)
    return Number.isNaN(t) ? 0 : t
  }
  return [...rows].sort((a, b) => at(b) - at(a) || a.clientName.localeCompare(b.clientName))
}

// ---- the client's own status link ---------------------------------------------------------

/** The steps a client sees on their status link, in order. */
export const PUBLIC_STEPS: readonly TrackStep[] = ['signup', 'intake', 'subaccount', 'website', 'number', 'texting', 'automations', 'gbp', 'qa']

export type PublicStatus = {
  business: string
  steps: { label: string; status: 'done' | 'in_progress' | 'pending' }[]
  /** The step being worked on, or null when every step is done. */
  currentStage: string | null
  nextStep: string
  updatedAt: string
}

/** Only labels and coarse states: never notes, dates, emails, links or ids. */
export function publicStatusView(steps: Record<TrackStep, StepView>, o: { business: string; updatedAt: string }): PublicStatus {
  const shown = PUBLIC_STEPS.map((s) => {
    const st = steps[s].state
    return { step: s, status: (st === 'done' || st === 'not_needed' ? 'done' : st === 'in_progress' || st === 'blocked' ? 'in_progress' : 'pending') as 'done' | 'in_progress' | 'pending' }
  })
  const current = shown.find((s) => s.status !== 'done')?.step ?? null
  return {
    business: o.business,
    steps: shown.map((s) => ({ label: STEP_PUBLIC[s.step].label, status: s.status })),
    currentStage: current ? STEP_PUBLIC[current].label : null,
    nextStep: current ? STEP_PUBLIC[current].next : 'All onboarding steps are complete.',
    updatedAt: o.updatedAt,
  }
}
