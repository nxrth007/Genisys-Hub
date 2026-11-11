/**
 * What to do next on the GHL agency page, given what's on screen.
 *
 * Pure: no Playwright, no database. The browser driver snapshots the
 * page, asks this, performs one action, and snapshots again. Tests
 * feed it fake pages. Wording lives in labels.ts; this is the order
 * of steps (sign in, 2FA, don't duplicate a name, fill, snapshot,
 * and only then Create).
 */
import type { BrowserFields } from './fields'
import { snapshotChoice } from './fields'
import type { GhlLabels } from './labels'

export type PageField = {
  key: string | null
  tag: string
  type: string
  value: string
  text: string
}

export type PageSnap = {
  url: string
  fields: PageField[]
  buttons: string[]
  texts: string[]
  links: { text: string; href: string }[]
  body: string
}

export type BrowserAction =
  | { type: 'goto'; url: string }
  | { type: 'click'; words: string[]; exact?: boolean }
  | { type: 'fill'; key: string; words: string[]; value?: string }
  | { type: 'pick'; key: string; words: string[]; value: string }
  | { type: 'wait_otp' }
  | { type: 'pause' }

export type DriveResult = {
  status: 'created' | 'already' | 'dry_run' | 'needs_human' | 'failed'
  locationId: string | null
  detail: string
  /** Create was clicked and GHL didn't confirm. Don't automatically try again. */
  uncertain: boolean
}

export type DriveInput = {
  fields: BrowserFields
  mode: 'dry_run' | 'create'
  labels: GhlLabels
  hasCredentials: boolean
  loginEmail: string
  hasOtp: boolean
  listUrl: string
}

export type RunState = {
  wentToList: boolean
  clickedNav: boolean
  loginPhase: 0 | 1 | 2 | 3
  otpPhase: 0 | 1 | 2
  searched: boolean
  openedCreate: boolean
  openedAdd: boolean
  filled: string[]
  missing: string[]
  snapshotTried: boolean
  submitted: boolean
  urlBeforeSubmit: string
  postSubmitWaits: number
  stalls: number
}

export function initialRunState(): RunState {
  return {
    wentToList: false,
    clickedNav: false,
    loginPhase: 0,
    otpPhase: 0,
    searched: false,
    openedCreate: false,
    openedAdd: false,
    filled: [],
    missing: [],
    snapshotTried: false,
    submitted: false,
    urlBeforeSubmit: '',
    postSubmitWaits: 0,
    stalls: 0,
  }
}

const STALL_LIMIT = 4
const POST_SUBMIT_WAITS = 8

const TEXT_KEYS = ['name', 'phone', 'address', 'city', 'postalCode', 'website', 'email', 'firstName', 'lastName'] as const
const PICK_KEYS = ['country', 'state', 'timezone'] as const

export function norm(s: string | null | undefined): string {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

export function locationIdFromUrl(url: string): string | null {
  return /\/location\/([A-Za-z0-9]{10,})/.exec(url)?.[1] ?? null
}

function hasButton(snap: PageSnap, words: string[]): boolean {
  const wants = words.map(norm)
  return snap.buttons.some((b) => {
    const t = norm(b)
    return wants.some((w) => t === w || t.startsWith(w + ' '))
  })
}

function fieldByKey(snap: PageSnap, key: string): PageField | undefined {
  return snap.fields.find((f) => f.key === key)
}

export function isLogin(snap: PageSnap): boolean {
  if (snap.fields.some((f) => f.key === 'password' || f.type === 'password')) return true
  return /\/login\b|\/sign-?in\b/i.test(snap.url) && snap.fields.some((f) => f.key === 'email' || f.type === 'email')
}

export function isOtp(snap: PageSnap): boolean {
  if (isLogin(snap)) return false
  if (snap.fields.some((f) => f.key === 'otp')) return true
  return /verification code|two-factor|two factor|authenticator|one-time code|one time code|enter the code|6-digit/.test(snap.body)
    && snap.fields.some((f) => f.type === 'text' || f.type === 'tel' || f.type === 'number' || f.tag === 'input')
}

function onForm(snap: PageSnap): boolean {
  return !!fieldByKey(snap, 'name')
}

function onList(snap: PageSnap, labels: GhlLabels): boolean {
  return /sub-accounts|agency_dashboard|\/accounts\b/i.test(snap.url) || hasButton(snap, labels.createButton)
}

function existingLocation(snap: PageSnap, name: string): string | null | undefined {
  const n = norm(name)
  if (!n) return undefined
  const link = snap.links.find((l) => norm(l.text) === n)
  if (link) return locationIdFromUrl(link.href)
  const text = [...snap.buttons, ...snap.texts].some((t) => norm(t) === n)
  return text ? null : undefined
}

function missingNote(state: RunState): string {
  return state.missing.length ? `Not on the form: ${state.missing.join(', ')}.` : ''
}

function done(state: RunState, result: DriveResult): { kind: 'done'; result: DriveResult; state: RunState } {
  return { kind: 'done', result, state }
}

function act(state: RunState, action: BrowserAction): { kind: 'action'; action: BrowserAction; state: RunState } {
  // A pause is the stall counter. Every other action means the page offered something to do.
  const stalls = action.type === 'pause' ? state.stalls : 0
  return { kind: 'action', action, state: { ...state, stalls } }
}

export type Step =
  | { kind: 'action'; action: BrowserAction; state: RunState }
  | { kind: 'done'; result: DriveResult; state: RunState }

export function nextGhlAction(snap: PageSnap, input: DriveInput, state: RunState): Step {
  let s = state
  for (let guard = 0; guard < 30; guard++) {
    if (s.submitted) {
      const id = locationIdFromUrl(snap.url)
      if (id && snap.url !== s.urlBeforeSubmit) {
        return done(s, { status: 'created', locationId: id, detail: missingNote(s), uncertain: false })
      }
      if (/sub-account created|successfully created|account created|location created/.test(snap.body)) {
        return done(s, { status: 'created', locationId: id, detail: missingNote(s) || 'GHL said it was created.', uncertain: !id })
      }
      if (!onForm(snap) && !isLogin(snap) && !isOtp(snap) && s.postSubmitWaits >= 2) {
        return done(s, {
          status: 'needs_human',
          locationId: id,
          uncertain: true,
          detail: `Clicked Create and the form closed, but no sub-account id was on the page. Check GHL for "${input.fields.name}" before resuming — a retry links that name instead of creating another. ${missingNote(s)}`.trim(),
        })
      }
      if (s.postSubmitWaits >= POST_SUBMIT_WAITS) {
        return done(s, {
          status: 'needs_human',
          locationId: null,
          uncertain: true,
          detail: `Clicked Create but GHL stayed on the form. It may still have been created — check GHL for "${input.fields.name}" before resuming. ${missingNote(s)}`.trim(),
        })
      }
      return act({ ...s, postSubmitWaits: s.postSubmitWaits + 1, stalls: s.stalls }, { type: 'pause' })
    }

    if (isLogin(snap)) {
      if (!input.hasCredentials) {
        return done(s, {
          status: 'needs_human',
          locationId: null,
          uncertain: false,
          detail: 'GHL is showing a sign-in page and no agency login is configured. Set GHL_AGENCY_EMAIL and GHL_AGENCY_PASSWORD, or the Vault entry "GHL Agency Dashboard Login".',
        })
      }
      if (s.loginPhase === 0) {
        if (!fieldByKey(snap, 'email') && !snap.fields.some((f) => f.type === 'email')) {
          s = { ...s, loginPhase: 1 }
          continue
        }
        return act({ ...s, loginPhase: 1 }, { type: 'fill', key: 'email', words: input.labels.email, value: input.loginEmail })
      }
      if (s.loginPhase === 1) {
        return act({ ...s, loginPhase: 2 }, { type: 'fill', key: 'password', words: input.labels.password })
      }
      if (s.loginPhase === 2) {
        return act({ ...s, loginPhase: 3 }, { type: 'click', words: input.labels.signIn, exact: true })
      }
      return done(s, {
        status: 'needs_human',
        locationId: null,
        uncertain: false,
        detail: 'GHL is still on the sign-in page after the saved login was tried. The password may be wrong, or GHL is showing a checkpoint a script should not click through.',
      })
    }

    if (isOtp(snap)) {
      if (s.otpPhase === 0 && !input.hasOtp) return act(s, { type: 'wait_otp' })
      if (s.otpPhase === 0) {
        return act({ ...s, otpPhase: 1 }, { type: 'fill', key: 'otp', words: input.labels.otp })
      }
      if (s.otpPhase === 1) {
        return act({ ...s, otpPhase: 2 }, { type: 'click', words: input.labels.verify, exact: true })
      }
      return done(s, {
        status: 'needs_human',
        locationId: null,
        uncertain: false,
        detail: 'GHL asked for a verification code and did not accept the one that was entered. Send a fresh code and retry.',
      })
    }

    const formOpen = onForm(snap)
    // Some GHL wizards ask for the snapshot before the business fields exist.
    // Don't record those fields as missing until the page that has them.
    const snapshotStep = !formOpen && !!fieldByKey(snap, 'snapshot') && (s.openedCreate || s.wentToList)
    if (formOpen || snapshotStep) {
      if (formOpen) {
        for (const key of TEXT_KEYS) {
          const value = input.fields[key]
          if (!value || s.filled.includes(key) || s.missing.includes(key)) continue
          const field = fieldByKey(snap, key)
          if (!field) {
            s = { ...s, missing: [...s.missing, key] }
            continue
          }
          if (norm(field.value)) {
            s = { ...s, filled: [...s.filled, key] }
            continue
          }
          return act({ ...s, filled: [...s.filled, key] }, { type: 'fill', key, words: input.labels[key] ?? [key], value })
        }
        for (const key of PICK_KEYS) {
          const value = input.fields[key]
          if (!value || s.filled.includes(key) || s.missing.includes(key)) continue
          const field = fieldByKey(snap, key)
          if (!field) {
            s = { ...s, missing: [...s.missing, key] }
            continue
          }
          if (norm(field.value)) {
            s = { ...s, filled: [...s.filled, key] }
            continue
          }
          return act({ ...s, filled: [...s.filled, key] }, { type: 'pick', key, words: input.labels[key] ?? [key], value })
        }
      }
      if (!s.snapshotTried) {
        const choice = snapshotChoice(input.fields)
        if (!choice) {
          return done(s, {
            status: 'needs_human',
            locationId: null,
            uncertain: false,
            detail: 'The snapshot name is not known, so nothing was created. Set GHL_SUBACCOUNT_SNAPSHOT_NAME to the name shown in GHL\'s snapshot dropdown (the id alone is not what the dropdown lists).',
          })
        }
        if (!fieldByKey(snap, 'snapshot') && !hasButton(snap, input.labels.snapshot)) {
          return done(s, {
            status: 'needs_human',
            locationId: null,
            uncertain: false,
            detail: 'The create form is open but there is no snapshot picker on it. A sub-account without the onboarding snapshot is worse than none. The form wording may have changed — set GHL_SUBACCOUNT_WORKER_LABELS.',
          })
        }
        return act({ ...s, snapshotTried: true }, { type: 'pick', key: 'snapshot', words: input.labels.snapshot, value: choice })
      }
      if (!formOpen) {
        if (s.stalls + 1 >= STALL_LIMIT) {
          return done(s, {
            status: 'needs_human',
            locationId: null,
            uncertain: false,
            detail: 'The snapshot step is on screen but the business-details form never opened. Nothing was created.',
          })
        }
        return act({ ...s, stalls: s.stalls + 1 }, { type: 'pause' })
      }
      if (input.mode === 'dry_run') {
        return done(s, {
          status: 'dry_run',
          locationId: null,
          uncertain: false,
          detail: `Filled "${input.fields.name}" and stopped before Create. ${missingNote(s)} Set GHL_SUBACCOUNT_WORKER_MODE=create to press Create.`.replace(/\s+/g, ' ').trim(),
        })
      }
      return act(
        { ...s, submitted: true, urlBeforeSubmit: snap.url },
        { type: 'click', words: input.labels.submit, exact: true },
      )
    }

    const existing = existingLocation(snap, input.fields.name)
    if (existing !== undefined) {
      return done(s, {
        status: 'already',
        locationId: existing,
        uncertain: false,
        detail: `A sub-account named "${input.fields.name}" is already in the list, so nothing new was created.`,
      })
    }

    if (!s.wentToList && !onList(snap, input.labels)) {
      return act({ ...s, wentToList: true }, { type: 'goto', url: input.listUrl })
    }
    if (!s.wentToList) s = { ...s, wentToList: true }

    if (!s.searched && fieldByKey(snap, 'search')) {
      return act({ ...s, searched: true }, { type: 'fill', key: 'search', words: input.labels.search, value: input.fields.name })
    }
    if (!s.openedCreate && hasButton(snap, input.labels.createButton)) {
      return act({ ...s, openedCreate: true }, { type: 'click', words: input.labels.createButton })
    }
    if (s.openedCreate && !s.openedAdd && hasButton(snap, input.labels.addBusiness)) {
      return act({ ...s, openedAdd: true }, { type: 'click', words: input.labels.addBusiness })
    }
    if (!s.clickedNav && hasButton(snap, input.labels.subAccountsNav)) {
      return act({ ...s, clickedNav: true }, { type: 'click', words: input.labels.subAccountsNav })
    }

    if (s.stalls + 1 >= STALL_LIMIT) {
      const saw = snap.buttons.slice(0, 8).join(', ') || '(no buttons)'
      return done(s, {
        status: 'needs_human',
        locationId: null,
        uncertain: false,
        detail: `Couldn't find the create-sub-account form on ${snap.url || 'the page'}. Buttons seen: ${saw}. GHL's wording may have changed — set GHL_SUBACCOUNT_WORKER_LABELS, or the session may not be in the agency view.`,
      })
    }
    return act({ ...s, stalls: s.stalls + 1 }, { type: 'pause' })
  }
  return done(s, {
    status: 'needs_human',
    locationId: null,
    uncertain: false,
    detail: 'Stopped: the page did not settle into a form GHL\'s create flow usually shows.',
  })
}

export type PageIo = {
  snapshot(): Promise<PageSnap>
  perform(action: BrowserAction): Promise<void>
  pullOtp(waitMs: number): Promise<string | null>
  onOtpPrompt(detail: string): Promise<void>
}

const DEFAULT_MAX_STEPS = 48
const DEFAULT_OTP_BUDGET_MS = 3 * 60 * 1000

/**
 * Drive one create until it finishes. `pullOtp` is asked while a
 * verification box is on screen; the budget is how long to wait
 * before asking a person.
 */
export async function driveUntil(
  io: PageIo,
  input: DriveInput,
  opts: { maxSteps?: number; otpBudgetMs?: number; now?: () => number } = {},
): Promise<DriveResult> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS
  const otpBudget = opts.otpBudgetMs ?? DEFAULT_OTP_BUDGET_MS
  const now = opts.now ?? Date.now
  let state = initialRunState()
  let current = input
  let otpStarted: number | null = null
  let otpAlerted = false
  let otpPolls = 0
  let steps = 0

  while (steps < maxSteps) {
    const snap = await io.snapshot()
    const step = nextGhlAction(snap, current, state)
    state = step.state
    if (step.kind === 'done') return step.result
    if (step.action.type === 'wait_otp') {
      if (!otpAlerted) {
        otpAlerted = true
        otpStarted = now()
        await io.onOtpPrompt(
          `GHL is asking for a verification code for ${input.fields.name}. Paste it in Settings → GHL sub-accounts, or POST {"otp":"..."} to the worker webhook. The page stays open for about 3 minutes.`,
        )
      }
      otpPolls += 1
      if ((otpStarted !== null && now() - otpStarted >= otpBudget) || otpPolls >= 100) {
        return {
          status: 'needs_human',
          locationId: null,
          uncertain: false,
          detail: 'GHL asked for a verification code and none arrived within 3 minutes. Send the code and the job will resume; the browser session was kept.',
        }
      }
      const code = await io.pullOtp(2000)
      if (code) current = { ...current, hasOtp: true }
      continue
    }
    steps += 1
    try {
      await io.perform(step.action)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (step.action.type === 'pick' && step.action.key === 'snapshot') {
        return {
          status: 'needs_human',
          locationId: null,
          uncertain: false,
          detail: `Couldn't pick the snapshot "${step.action.value}": ${message}. Nothing was created.`,
        }
      }
      if (step.action.type === 'fill' || step.action.type === 'pick') {
        const key = step.action.key
        if (!state.missing.includes(key)) state = { ...state, missing: [...state.missing, key] }
        continue
      }
      throw err
    }
  }
  return {
    status: 'failed',
    locationId: null,
    uncertain: state.submitted,
    detail: state.submitted
      ? 'Timed out after clicking Create. Check GHL before retrying — it may have gone through.'
      : 'Timed out before the form was finished. The GHL page may have changed or the session was stuck.',
  }
}
