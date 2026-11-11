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
  /** Remember-device checkboxes, when the page has them. */
  checks?: { text: string; checked: boolean }[]
  body: string
}

export type BrowserAction =
  | { type: 'goto'; url: string }
  | { type: 'click'; words: string[]; exact?: boolean; contains?: boolean }
  | { type: 'fill'; key: string; words: string[]; value?: string }
  | { type: 'pick'; key: string; words: string[]; value: string }
  | { type: 'wait_otp'; channel: string }
  | { type: 'fill_otp' }
  | { type: 'press_enter' }
  | { type: 'click_verify'; words: string[] }
  | { type: 'remember' }
  | { type: 'pause' }

export type DriveResult = {
  status: 'created' | 'already' | 'dry_run' | 'needs_human' | 'failed'
  locationId: string | null
  detail: string
  /** Create was clicked and GHL didn't confirm. Don't automatically try again. */
  uncertain: boolean
  /** Left the login and the code page for the agency dashboard. */
  reachedAgency?: boolean
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
  otpPhase: number
  rememberTicked: boolean
  trustNote: string
  /** Pauses after the code was typed, waiting to leave the code page. */
  otpSettle: number
  /** Pauses after clicking Sub-Accounts, so the list can render. */
  navWaits: number
  /** How many list URLs have been opened. */
  listGotos: number
  /** Snapshot was chosen in the blank-vs-snapshot modal. */
  choseSnapshot: boolean
  /** URL and buttons at each navigation step, for the job detail. */
  navTrail: string[]
  /** Email was chosen when GHL offered email and phone. */
  codeMethodChosen: boolean
  /** "Send security code" was clicked; waiting for the box. */
  codeSent: boolean
  codeChannel: string
  codeSendWaits: number
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
    rememberTicked: false,
    trustNote: '',
    otpSettle: 0,
    navWaits: 0,
    listGotos: 0,
    choseSnapshot: false,
    navTrail: [],
    codeMethodChosen: false,
    codeSent: false,
    codeChannel: '',
    codeSendWaits: 0,
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

function pathOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url.split('?')[0] || url
  }
}

/** The agency app, not the login interstitial whose query string mentions sub-accounts. */
export function isAgencyHome(snap: PageSnap): boolean {
  if (isLogin(snap) || isOtp(snap) || isSecurityCodeGate(snap)) return false
  return /agency_dashboard|\/sub-accounts|\/accounts/.test(pathOf(snap.url))
}

function rememberChoice(snap: PageSnap): { text: string; checked: boolean } | undefined {
  return (snap.checks || []).find((c) => /remember|trust this device|trusted device|don.?t ask|do not ask/.test(norm(c.text)))
}

/** Button and input labels for a failed code page. Digit codes are blanked out. */
export function pageDiagnostics(snap: PageSnap): string {
  const redact = (s: string) => s.replace(/\b\d{4,8}\b/g, '••••')
  const buttons = snap.buttons.slice(0, 25).join(' | ') || '(none)'
  const inputs = snap.fields.slice(0, 15).map((f) => [f.tag, f.type, f.key || '', redact(f.text || '')].filter(Boolean).join(' ')).join('; ') || '(none)'
  const checks = (snap.checks || []).map((c) => `${c.text}${c.checked ? ' (checked)' : ''}`).join(' | ')
  const body = redact(snap.body || '').slice(0, 400)
  return [`url: ${snap.url}`, `buttons: ${buttons}`, `inputs: ${inputs}`, checks ? `checks: ${checks}` : '', `text: ${body}`].filter(Boolean).join('\n')
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
  // The interstitial's only control is "Send security code". That is not the entry box.
  if (isSecurityCodeGate(snap)) return false
  return /verification code|security code|two-factor|two factor|authenticator|one-time code|one time code|enter the code|6-digit/.test(snap.body)
    && snap.fields.some((f) => f.type === 'text' || f.type === 'tel' || f.type === 'number' || f.tag === 'input')
}

/**
 * After the password, GHL often shows a page whose only button is
 * "Send security code" (sometimes with an email/phone choice) before
 * the code box exists. The live dry run stopped here.
 */
export function isSecurityCodeGate(snap: PageSnap): boolean {
  if (snap.fields.some((f) => f.key === 'password' || f.type === 'password')) return false
  if (snap.fields.some((f) => f.key === 'name')) return false
  return snap.buttons.some((b) => /send security code|^send code$/.test(norm(b)))
}

/** Where the code is going, from the words on the page. Empty-ish if GHL didn't say. */
export function securityCodeChannel(snap: PageSnap): string {
  const body = snap.body || ''
  const buttons = snap.buttons.map(norm)
  const emailAddr = body.match(/[a-z0-9][a-z0-9.*+_]*@[a-z0-9.*]+\.[a-z]{2,}/i)?.[0]
  const phone = body.match(/(?:\+?\d[\d\s().*-]{6,}\d)/)?.[0]
  const emailBtn = buttons.some((b) => b === 'email' || b === 'email me')
  const phoneBtn = buttons.some((b) => b === 'sms' || b === 'text' || b === 'phone' || b === 'text message' || b.includes('text message'))
  const emailBody = /\bemail\b/.test(body)
  const phoneBody = /\b(text message|sms|phone)\b/.test(body) || (/\btext\b/.test(body) && !/context/.test(body))
  if ((emailBody || emailBtn) && (phoneBody || phoneBtn)) {
    return emailAddr
      ? `email (${emailAddr}); a text option was also on the page`
      : 'email (a text option was also on the page)'
  }
  if (emailAddr && (emailBody || emailBtn || !phoneBody)) return `email (${emailAddr})`
  if (emailBody || emailBtn) return 'email'
  if (phone && (phoneBody || phoneBtn)) return `text message (${phone.trim()})`
  if (phoneBody || phoneBtn) return 'text message'
  return 'the login’s email or phone (the page did not say which)'
}

function codeMethods(snap: PageSnap): { email: boolean; phone: boolean } {
  const buttons = snap.buttons.map(norm)
  return {
    email: buttons.some((b) => b === 'email' || b === 'email me'),
    phone: buttons.some((b) => b === 'sms' || b === 'text' || b === 'phone' || b === 'text message' || b.includes('text message')),
  }
}

function onForm(snap: PageSnap): boolean {
  return !!fieldByKey(snap, 'name')
}

/** "+ Create Sub-Account" and the older wording, ignoring a leading plus. */
export function isCreateSubAccountButton(text: string): boolean {
  const t = norm(text).replace(/^[+\uFF0B]\s*/, '')
  return /create sub-?account|add sub-?account|new sub-?account/.test(t)
}

function hasCreateButton(snap: PageSnap): boolean {
  return snap.buttons.some(isCreateSubAccountButton)
}

function hasSubAccountsNav(snap: PageSnap): boolean {
  return snap.buttons.some((b) => /^(sub-?accounts?|sub accounts?)(\b|$)/.test(norm(b)))
}

/** The blank-vs-snapshot modal. The left-nav item "account snapshots" is not this. */
function snapshotWizardButton(snap: PageSnap): string | null {
  const buttons = snap.buttons.filter((b) => !/account snapshots/.test(norm(b)))
  const blank = buttons.some((b) => /\bblank\b|from scratch|start from scratch|empty account/.test(norm(b)))
  if (!blank) return null
  return buttons.find((b) => /\bsnapshot\b/.test(norm(b))) ?? null
}

export function listCandidates(listUrl: string): string[] {
  let origin = 'https://app.gohighlevel.com'
  try {
    origin = new URL(listUrl).origin
  } catch {
    // keep the default agency origin
  }
  return [`${origin}/accounts/sub-accounts`, `${origin}/sub-accounts`, `${origin}/agency/sub-accounts`, `${origin}/agency/accounts`]
}

function withNote(state: RunState, snap: PageSnap, what: string): RunState {
  const buttons = snap.buttons.slice(0, 10).join(', ') || '(none)'
  const line = `${what}: ${snap.url || '(no url)'} | ${buttons}`
  return { ...state, navTrail: [...state.navTrail, line].slice(-12) }
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
      const channel = s.codeChannel || securityCodeChannel(snap)
      if (s.otpPhase === 0 && !input.hasOtp) return act({ ...s, codeChannel: channel }, { type: 'wait_otp', channel })
      const box = rememberChoice(snap)
      if (!s.rememberTicked && box && !box.checked) {
        const days = box.text.match(/(\d+)\s*days/i)?.[1]
        const note = days
          ? `GHL’s checkbox says this browser stays trusted for ${days} days.`
          : 'A remember-this-device box was ticked. HighLevel’s login has commonly kept that trust for 30 days; this page did not state a number.'
        return act({ ...s, rememberTicked: true, trustNote: note, codeChannel: channel }, { type: 'remember' })
      }
      if (s.otpPhase < 2) {
        return act({ ...s, otpPhase: 2, codeChannel: channel, rememberTicked: true }, { type: 'fill_otp' })
      }
      // GHL often submits itself once every digit box is filled. Give that a moment.
      if (s.otpPhase === 2) return act({ ...s, otpPhase: 3, stalls: 0 }, { type: 'pause' })
      if (s.otpPhase === 3) return act({ ...s, otpPhase: 4 }, { type: 'press_enter' })
      if (s.otpPhase === 4) return act({ ...s, otpPhase: 5, stalls: 0 }, { type: 'pause' })
      if (s.otpPhase === 5) {
        return act({ ...s, otpPhase: 6 }, { type: 'click_verify', words: input.labels.verify ?? ['Verify', 'Confirm Code', 'Login', 'Sign in'] })
      }
      if (s.otpSettle < 4) return act({ ...s, otpSettle: s.otpSettle + 1, stalls: 0 }, { type: 'pause' })
      return done(s, {
        status: 'needs_human',
        locationId: null,
        uncertain: false,
        detail: `The security code was typed but the page did not leave the code screen, so it was not accepted.\n${pageDiagnostics(snap)}`,
      })
    }

    if (isSecurityCodeGate(snap)) {
      const channel = securityCodeChannel(snap)
      const methods = codeMethods(snap)
      if (!s.codeMethodChosen && methods.email && methods.phone) {
        return act(
          { ...s, codeMethodChosen: true, codeChannel: channel.includes('email') ? channel : 'email' },
          { type: 'click', words: ['Email'], exact: true },
        )
      }
      if (!s.codeSent) {
        return act(
          { ...s, codeSent: true, codeMethodChosen: true, codeChannel: s.codeChannel || channel },
          { type: 'click', words: input.labels.sendSecurityCode ?? ['Send security code', 'Send code'] },
        )
      }
      if (s.codeSendWaits >= 8) {
        return done(s, {
          status: 'needs_human',
          locationId: null,
          uncertain: false,
          detail: `Clicked “Send security code” (${s.codeChannel || channel}) but the code box never appeared. Check that button on the GHL page, or set GHL_SUBACCOUNT_WORKER_LABELS.`,
        })
      }
      return act({ ...s, codeSendWaits: s.codeSendWaits + 1, stalls: 0 }, { type: 'pause' })
    }

    const formOpen = onForm(snap)
    // Some GHL wizards ask for the snapshot before the business fields exist.
    // Don't record those fields as missing until the page that has them.
    const snapshotStep = !formOpen && !!fieldByKey(snap, 'snapshot') && (s.openedCreate || hasCreateButton(snap))
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

    if (s.openedCreate && !s.choseSnapshot) {
      const choice = snapshotWizardButton(snap)
      if (choice) {
        return act(withNote({ ...s, choseSnapshot: true }, snap, 'choose snapshot'), {
          type: 'click',
          words: [choice, 'From snapshot', 'Use snapshot', 'Snapshot'],
          contains: true,
        })
      }
    }
    if (s.openedCreate && !s.openedAdd && hasButton(snap, input.labels.addBusiness)) {
      return act({ ...s, openedAdd: true }, { type: 'click', words: input.labels.addBusiness, contains: true })
    }
    // The modal is opening or the details form is not in the snapshot yet.
    // Don't leave this page for another URL.
    if (s.openedCreate && !onForm(snap)) {
      if (s.stalls + 1 >= STALL_LIMIT) {
        const trail = s.navTrail.length ? `\nSteps:\n${s.navTrail.join('\n')}` : ''
        return done(s, {
          status: 'needs_human',
          locationId: null,
          uncertain: false,
          detail: `Couldn't find the create-sub-account form.\n${pageDiagnostics(snap)}${trail}`,
        })
      }
      return act(withNote({ ...s, stalls: s.stalls + 1 }, snap, 'waiting for the create form'), { type: 'pause' })
    }

    if (hasCreateButton(snap) && !s.openedCreate) {
      const existing = existingLocation(snap, input.fields.name)
      if (existing !== undefined) {
        return done(s, {
          status: 'already',
          locationId: existing,
          uncertain: false,
          detail: `A sub-account named "${input.fields.name}" is already in the list, so nothing new was created.`,
        })
      }
      if (!s.searched && fieldByKey(snap, 'search')) {
        return act({ ...s, searched: true, wentToList: true }, { type: 'fill', key: 'search', words: input.labels.search, value: input.fields.name })
      }
      const label = snap.buttons.find(isCreateSubAccountButton) || 'Create Sub-Account'
      return act(withNote({ ...s, openedCreate: true, wentToList: true }, snap, 'click create'), {
        type: 'click',
        words: [label, ...(input.labels.createButton ?? [])],
        contains: true,
      })
    }

    // /accounts is the agency shell (left nav). The sub-account list is the
    // view behind "Sub-Accounts", which is what carries the create button.
    if (!s.clickedNav && hasSubAccountsNav(snap)) {
      return act(withNote({ ...s, clickedNav: true }, snap, 'click Sub-Accounts'), {
        type: 'click',
        words: input.labels.subAccountsNav ?? ['Sub-Accounts', 'Sub Accounts'],
        contains: true,
      })
    }
    const candidates = listCandidates(input.listUrl)
    const navSettled = !hasSubAccountsNav(snap) || s.clickedNav
    if (navSettled && s.clickedNav && s.navWaits < 2 && s.listGotos === 0) {
      return act(withNote({ ...s, navWaits: s.navWaits + 1 }, snap, 'waiting for the sub-account list'), { type: 'pause' })
    }
    if (navSettled && s.listGotos < candidates.length) {
      let i = s.listGotos
      while (i < candidates.length && pathOf(snap.url) === pathOf(candidates[i]!)) i += 1
      if (i < candidates.length) {
        const url = candidates[i]!
        return act(withNote({ ...s, listGotos: i + 1, wentToList: true }, snap, `open ${url}`), { type: 'goto', url })
      }
      s = { ...s, listGotos: i, wentToList: true }
    }

    if (s.stalls + 1 >= STALL_LIMIT) {
      const trail = s.navTrail.length ? `\nSteps:\n${s.navTrail.join('\n')}` : ''
      return done(s, {
        status: 'needs_human',
        locationId: null,
        uncertain: false,
        detail: `Couldn't find the create-sub-account form.\n${pageDiagnostics(snap)}${trail}`,
      })
    }
    return act(withNote({ ...s, stalls: s.stalls + 1 }, snap, 'still no create form'), { type: 'pause' })
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

export const OTP_WAIT_MS = 12 * 60 * 1000
const DEFAULT_MAX_STEPS = 48
const DEFAULT_OTP_BUDGET_MS = OTP_WAIT_MS
/** Fuse if pullOtp returns immediately. 12 minutes at 2s per poll is 360. */
const OTP_POLL_CAP = 450

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
  let reachedAgency = false
  let lastSnap: PageSnap | null = null
  const finish = (result: DriveResult): DriveResult => {
    const detail = state.trustNote && !result.detail.includes(state.trustNote) ? `${result.detail}\n${state.trustNote}` : result.detail
    return { ...result, detail, ...(reachedAgency ? { reachedAgency: true } : {}) }
  }

  while (steps < maxSteps) {
    const snap = await io.snapshot()
    lastSnap = snap
    if (isAgencyHome(snap)) reachedAgency = true
    const step = nextGhlAction(snap, current, state)
    state = step.state
    if (step.kind === 'done') return finish(step.result)
    if (step.action.type === 'wait_otp') {
      const channel = step.action.channel
      const where = channel ? ` GHL is sending it by ${channel}.` : ''
      if (!otpAlerted) {
        otpAlerted = true
        otpStarted = now()
        await io.onOtpPrompt(
          `Waiting for a GHL security code for ${input.fields.name}.${where} Paste it in Settings → GHL sub-accounts, or POST {"otp":"..."} to /api/webhooks/ghl-subaccount-worker. The page stays open for 12 minutes.`,
        )
      }
      otpPolls += 1
      if ((otpStarted !== null && now() - otpStarted >= otpBudget) || otpPolls >= OTP_POLL_CAP) {
        return finish({
          status: 'needs_human',
          locationId: null,
          uncertain: false,
          detail: `GHL asked for a security code${channel ? ` (${channel})` : ''} and none was entered within 12 minutes, so the page was closed. A retry sends a new code. The login session was saved.${lastSnap ? `\n${pageDiagnostics(lastSnap)}` : ''}`,
        })
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
      if (step.action.type === 'fill_otp') {
        return finish({
          status: 'needs_human',
          locationId: null,
          uncertain: false,
          detail: `Could not type the security code. ${message}${lastSnap ? `\n${pageDiagnostics(lastSnap)}` : ''}`,
        })
      }
      if (step.action.type === 'click_verify' || step.action.type === 'press_enter' || step.action.type === 'remember') {
        continue
      }
      throw err
    }
  }
  return finish({
    status: 'failed',
    locationId: null,
    uncertain: state.submitted,
    detail: state.submitted
      ? 'Timed out after clicking Create. Check GHL before retrying — it may have gone through.'
      : 'Timed out before the form was finished. The GHL page may have changed or the session was stuck.',
  })
}
