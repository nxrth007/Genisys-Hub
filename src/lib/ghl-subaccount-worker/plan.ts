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
import { ghlSubAccountName, snapshotChoice } from './fields'
import type { GhlLabels } from './labels'

export type PageField = {
  key: string | null
  tag: string
  type: string
  value: string
  /** Visible label, aria-label, or nearby text. */
  text: string
  /** Placeholder, kept separate so a dry run can record both. */
  placeholder?: string
  /** input name attribute. */
  name?: string
  /** input id attribute. */
  id?: string
  /** aria-label or aria-labelledby text. */
  aria?: string
  /** Short text from the parent label or the preceding sibling. */
  nearby?: string
}

export type PageSnap = {
  url: string
  fields: PageField[]
  buttons: string[]
  texts: string[]
  links: { text: string; href: string }[]
  /** Remember-device checkboxes, when the page has them. */
  checks?: { text: string; checked: boolean }[]
  /** Every frame that was read, including ones whose UI is blank. */
  frames?: { url: string; buttons: string[]; fieldCount: number }[]
  /** href of the Sub-Accounts control that was just clicked. */
  navHref?: string
  /** Snapshot-template tabs, including their counts. */
  tabs?: string[]
  /** Snapshot card titles inside the template modal. */
  cards?: string[]
  /** Cards whose DOM exposed a snapshot id. */
  cardRefs?: { name: string; id: string }[]
  /** Visible dialogs, modals, and drawers. */
  overlays?: string[]
  body: string
}

export type BrowserAction =
  | { type: 'goto'; url: string; settle?: boolean }
  | { type: 'click'; words: string[]; exact?: boolean; contains?: boolean; settle?: boolean | 'modal' | 'form' }
  | { type: 'wait_list' }
  | { type: 'fill'; key: string; words: string[]; value?: string }
  | { type: 'pick'; key: string; words: string[]; value: string }
  | { type: 'wait_otp'; channel: string }
  | { type: 'fill_otp' }
  | { type: 'press_enter' }
  | { type: 'click_verify'; words: string[] }
  | { type: 'select_card'; name: string; id?: string }
  | { type: 'add_manually' }
  | { type: 'scroll_form' }
  | { type: 'record_form' }
  | { type: 'note'; text: string }
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
  /** snapshot query param GHL put on the business-search URL. */
  observedSnapshotId?: string
}

export type DriveInput = {
  fields: BrowserFields
  mode: 'dry_run' | 'create'
  labels: GhlLabels
  hasCredentials: boolean
  loginEmail: string
  hasOtp: boolean
  listUrl: string
  /** GHL_SUBACCOUNT_LIST_URL, when set. Tried after the nav click, before any guessed path. */
  listUrlOverride?: string
  /** GHL_SUBACCOUNT_SNAPSHOT_TAB, when set. Opened before the default tab order. */
  snapshotTab?: string
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
  /** Already waited out the sub-account list skeleton. */
  listWaited: boolean
  /** Snapshot was chosen in the blank-vs-snapshot modal. */
  choseSnapshot: boolean
  /** URL and buttons after each navigation has settled. */
  navTrail: string[]
  /** Label of the navigation that just ran. Recorded against the next snapshot. */
  pendingStep: string
  /** GHL_SUBACCOUNT_LIST_URL was already opened. */
  triedOverride: boolean
  /** Snapshot card was confirmed with Select & Continue. */
  snapshotChosen: boolean
  /** Snapshot-template tabs already opened, in the order they were tried. */
  snapshotTabsTried: string[]
  /** Add manually was clicked on the Google business-search step. */
  manualAdded: boolean
  /** The details drawer was scrolled so the footer button is in view. */
  formScrolled: boolean
  /** Dry run already captured the filled form. */
  formRecorded: boolean
  /** The missing-first-name warning was written to the job log. */
  nameWarned: boolean
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
  /** After Add Sub-Account, opened the list once to look for the new row. */
  confirmListed: boolean
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
    listWaited: false,
    choseSnapshot: false,
    navTrail: [],
    pendingStep: '',
    triedOverride: false,
    snapshotChosen: false,
    snapshotTabsTried: [],
    manualAdded: false,
    formScrolled: false,
    formRecorded: false,
    nameWarned: false,
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
    confirmListed: false,
    stalls: 0,
  }
}

const STALL_LIMIT = 4
const POST_SUBMIT_WAITS = 8

/** Business fields, in the order a person reads the details form. */
const DETAIL_KEYS = ['firstName', 'lastName', 'email', 'name', 'phone', 'address', 'city', 'state', 'postalCode', 'country', 'website', 'timezone'] as const
const LABEL_SKIP = new Set(['submit', 'createButton', 'signIn', 'verify', 'sendSecurityCode', 'addManually', 'subAccountsNav', 'addBusiness'])

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
  const inputs = snap.fields.slice(0, 40).map((f) => {
    const bits = [f.tag, f.type, f.key || '', redact(f.text || ''), f.placeholder ? `placeholder=${redact(f.placeholder)}` : ''].filter(Boolean)
    return bits.join(' ')
  }).join('; ') || '(none)'
  const checks = (snap.checks || []).map((c) => `${c.text}${c.checked ? ' (checked)' : ''}`).join(' | ')
  const overlays = (snap.overlays || []).slice(0, 12).map((item) => redact(item)).join(' | ') || '(none)'
  const body = redact(snap.body || '').slice(0, 400)
  const frames = (snap.frames || []).map((frame) => {
    const seen = frame.buttons.slice(0, 8).join(', ') || '(none)'
    return `${frame.url || '(no url)'} | inputs=${frame.fieldCount} | ${seen}`
  })
  return [`url: ${snap.url}`, `buttons: ${buttons}`, `inputs: ${inputs}`, `overlays: ${overlays}`, checks ? `checks: ${checks}` : '', frames.length ? `frames:\n${frames.join('\n')}` : '', `text: ${body}`].filter(Boolean).join('\n')
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

export function snapshotIdFromUrl(url: string): string | null {
  try {
    const id = new URL(url).searchParams.get('snapshot')?.trim() || ''
    return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : null
  } catch {
    return null
  }
}

function onForm(snap: PageSnap): boolean {
  return !!fieldByKey(snap, 'name')
}

function isBusinessSearch(snap: PageSnap): boolean {
  if (onForm(snap)) return false
  if (/\/accounts\/search\b/i.test(snap.url || '')) return true
  const blob = `${snap.body}\n${snap.buttons.join('\n')}\n${snap.links.map((link) => link.text).join('\n')}`
  const hasSearch = snap.fields.some((field) => field.key === 'search' || field.text === 'search' || field.placeholder === 'search')
  return /add manually/.test(blob) && hasSearch
}

function isSnapshotModal(snap: PageSnap): boolean {
  if ((snap.tabs || []).length > 0) return true
  if ((snap.cards || []).length > 0 && /snapshot/.test(snap.body)) return true
  return /select snapshot template/.test(snap.body)
}

function humanize(value: string | null | undefined): string {
  return norm(value).replace(/[_./]+/g, ' ').replace(/\b(input|field|form|hl)\b/g, ' ').replace(/\s+/g, ' ').trim()
}

function looseHit(text: string, word: string): boolean {
  if (!text || !word) return false
  if (word.length <= 4) return text === word
  return text === word || text.includes(word)
}

/** name, id, and nearby text must be the label, not a sentence that mentions it. */
function strictHit(text: string, word: string): boolean {
  if (!text || !word) return false
  if (text === word) return true
  if (word.length <= 4) return false
  return text.startsWith(`${word} `) || text.endsWith(` ${word}`)
}

export function fieldDisplayName(field: PageField): string {
  const name = field.text || field.aria || field.nearby || humanize(field.name) || humanize(field.id) || field.key || ''
  if (field.placeholder && norm(field.placeholder) !== norm(name)) return `${name || field.tag} / ${field.placeholder}`
  return name || field.placeholder || field.tag
}

export function isDropdownField(field: PageField): boolean {
  return field.tag === 'select' || field.tag === 'dropdown' || field.type === 'select' || field.type === 'select-one' || field.type === 'dropdown'
}

/** Country and time zone are custom dropdowns even when the snapshot sees a text input. */
const ALWAYS_PICK = new Set(['country', 'timezone'])

function controlHow(field: PageField | undefined, key: string): 'dropdown' | 'text' {
  if (ALWAYS_PICK.has(key) || (field && isDropdownField(field))) return 'dropdown'
  return 'text'
}

/** Fill a null key from the label, aria-label, nearby text, name, or id. */
export function assignFieldKeys(fields: PageField[], labels: GhlLabels): PageField[] {
  return fields.map((field) => {
    if (field.key) return field
    const loose = [field.text, field.aria, field.placeholder].map((bit) => norm(bit))
    const strict = [field.nearby, humanize(field.name), humanize(field.id)].map((bit) => norm(bit))
    for (const key of Object.keys(labels)) {
      if (LABEL_SKIP.has(key)) continue
      for (const word of labels[key] || []) {
        const want = norm(word)
        if (loose.some((bit) => looseHit(bit, want)) || strict.some((bit) => strictHit(bit, want))) {
          return { ...field, key }
        }
      }
    }
    return field
  })
}

function fieldLabelNote(snap: PageSnap): string {
  const parts = snap.fields.map((field) => fieldDisplayName(field))
  return parts.length ? `Fields: ${parts.join(', ')}.` : 'No field labels were visible on the form.'
}

const SAVE_RANK = [/^save changes$/, /^add sub-?account$/, /^save$/, /^create$/, /^[+＋]?\s*create sub-?account$/, /^add$/, /^submit$/, /^done$/]

/** The footer control. "Create new" is the header and is not this. */
export function bestSaveLabel(buttons: string[]): string {
  const skip = (text: string) => /^(create new|add manually|cancel|search)$/.test(text) || text.startsWith('back to')
  const entries = buttons
    .map((raw) => ({ raw: raw.replace(/\s+/g, ' ').trim(), text: norm(raw).replace(/^[+＋]\s*/, '') }))
    .filter((item) => item.raw && !skip(item.text))
  for (const rank of SAVE_RANK) {
    const hit = entries.find((item) => rank.test(item.text))
    if (hit) return hit.raw
  }
  return '(no save button seen)'
}

function finalSaveLabel(snap: PageSnap): string {
  return bestSaveLabel(snap.buttons)
}

function setNote(snap: PageSnap, input: DriveInput, state: RunState): string {
  const parts = DETAIL_KEYS.filter((key) => input.fields[key] && state.filled.includes(key)).map((key) => {
    const field = fieldByKey(snap, key)
    const how = controlHow(field, key)
    const label = field ? fieldDisplayName(field) : key
    return `${key}=${JSON.stringify(input.fields[key])} (${how}, "${label}")`
  })
  return parts.length ? `Set ${parts.join(', ')}.` : ''
}

/** The list's own button. The header control "create new" is not this. */
export function isCreateSubAccountButton(text: string): boolean {
  return /^[+＋]?\s*create sub-?account$/.test(norm(text))
}

/** How long to wait for the real sub-account list, including one reload. */
export const LIST_RENDER_WAIT_MS = 45_000

export function isSubAccountListReady(snap: PageSnap): boolean {
  if (snap.buttons.some(isCreateSubAccountButton)) return true
  const blob = `${snap.body}\n${(snap.texts || []).join('\n')}\n${snap.buttons.join('\n')}`
  if (/start creating sub-?accounts/.test(blob)) return false
  return /\d+\s+sub-?accounts?\b/.test(blob)
}

function onSubAccountsPath(url: string): boolean {
  return /\/sub-accounts(\/|$)/i.test(pathOf(url))
}

const DEFAULT_SNAPSHOT_TABS = ['Imported Snapshots', 'My Snapshots', 'Snapshot Templates']

export function tabLabel(text: string): string {
  return norm(text).replace(/\s*\(\d+\)\s*$/, '').trim()
}

export function tabMatches(label: string, wanted: string): boolean {
  return tabLabel(label) === tabLabel(wanted)
}

/** Configured tab first, then Imported, My Snapshots, and Snapshot Templates. */
export function snapshotTabPlan(preferred?: string | null): string[] {
  const pref = (preferred || '').trim()
  if (!pref) return [...DEFAULT_SNAPSHOT_TABS]
  const known = DEFAULT_SNAPSHOT_TABS.find((tab) => tabMatches(tab, pref))
  if (!known) return [pref, ...DEFAULT_SNAPSHOT_TABS]
  return [known, ...DEFAULT_SNAPSHOT_TABS.filter((tab) => tab !== known)]
}

/** Exact card title. "Master Template Extra" is not "Master Template". */
export function exactSnapshotCard(cards: string[], name: string): string | null {
  const want = norm(name)
  if (!want) return null
  return cards.find((card) => norm(card) === want) ?? null
}

/**
 * The card to click. An id on the card wins. Two cards with the same
 * name and different ids are not guessed.
 */
export function chooseSnapshotCard(
  cards: string[],
  refs: { name: string; id: string }[] | undefined,
  name: string,
  id: string,
): { ok: true; name: string; id: string } | { ok: false; detail: string } {
  const wantName = norm(name)
  const wantId = id.trim()
  const list = refs || []
  if (wantId) {
    const byId = list.filter((ref) => ref.id === wantId)
    if (byId.length === 1) return { ok: true, name: byId[0].name || name, id: wantId }
    if (byId.length > 1) return { ok: false, detail: `More than one card has snapshot id ${wantId}. Nothing was created.` }
  }
  const sameName = list.filter((ref) => norm(ref.name) === wantName && ref.id)
  const distinct = [...new Set(sameName.map((ref) => ref.id))]
  if (distinct.length > 1) {
    return {
      ok: false,
      detail: `More than one snapshot is named "${name}": ${distinct.join(', ')}. Set GHL_SUBACCOUNT_SNAPSHOT_ID to the one that has assets. Nothing was created.`,
    }
  }
  const card = exactSnapshotCard(cards, name)
  if (!card) return { ok: false, detail: '' }
  return { ok: true, name: card, id: wantId || distinct[0] || '' }
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
  return [`${origin}/sub-accounts`, `${origin}/agency/sub-accounts`, `${origin}/agency/accounts`]
}

function describeSnap(snap: PageSnap): string {
  const buttons = snap.buttons.slice(0, 10).join(', ') || '(none)'
  const href = snap.navHref ? ` href=${snap.navHref}` : ''
  const frames = (snap.frames || []).map((frame) => frame.url).filter(Boolean)
  const frameBit = frames.length ? ` frames=[${frames.join(' | ')}]` : ''
  return `${snap.url || '(no url)'}${href}${frameBit} | ${buttons}`
}

/** The snapshot is the page after `pendingStep` ran. Record that, not the page from before it. */
function noteSettled(state: RunState, snap: PageSnap): RunState {
  if (!state.pendingStep) return state
  const line = `${state.pendingStep}: ${describeSnap(snap)}`
  return { ...state, pendingStep: '', navTrail: [...state.navTrail, line].slice(-12) }
}

function beginStep(state: RunState, label: string): RunState {
  return { ...state, pendingStep: label }
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

/** Toast, banner, or button copy GHL shows after Add Sub-Account. The button label itself is not this. */
export function createSuccessCopy(snap: PageSnap): boolean {
  const blob = [snap.body || '', ...(snap.overlays || []), ...snap.buttons, ...snap.texts].join('\n')
  return /sub-?accounts? (has been |was )?(created|added|saved)|accounts? (has been |was )?(created|added)|locations? (has been |was )?(created|added)|successfully (created|added|saved)|(created|added|saved) successfully/.test(blob)
}

/** Exact sub-account name already visible as a list row or link. */
export function listedSubAccount(snap: PageSnap, name: string): { locationId: string | null } | null {
  const want = norm(name)
  if (!want) return null
  const link = snap.links.find((item) => norm(item.text) === want)
  if (link) return { locationId: locationIdFromUrl(link.href) }
  if ([...snap.buttons, ...snap.texts].some((item) => norm(item) === want)) return { locationId: null }
  return null
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
  const accountName = ghlSubAccountName(input.fields.firstName, input.fields.name)
  input = { ...input, fields: { ...input.fields, name: accountName.name } }
  snap = { ...snap, fields: assignFieldKeys(snap.fields || [], input.labels) }
  let s = noteSettled(state, snap)
  const formOpenNow = onForm(snap)
  const urlSnapshot = snapshotIdFromUrl(snap.url)
  const snapField = fieldByKey(snap, 'snapshot')
  const wantedSnapshot = input.fields.snapshotId.trim()
  // A snapshot id on the URL is the card that was selected. It does not fill a
  // snapshot control that is still empty on the details form. A different id
  // than the one configured is not accepted.
  if (urlSnapshot && wantedSnapshot && urlSnapshot !== wantedSnapshot && !s.submitted) {
    return done(s, {
      status: 'needs_human',
      locationId: null,
      uncertain: false,
      detail: `The page URL snapshot is ${urlSnapshot}, not the configured snapshot ${wantedSnapshot}. Nothing was created.\n${pageDiagnostics(snap)}`,
    })
  }
  if (urlSnapshot && !s.snapshotChosen && !(formOpenNow && snapField && !norm(snapField.value))) {
    const readName = (snap.cardRefs || []).find((ref) => ref.id === urlSnapshot)?.name || input.fields.snapshotName || '(name not on the page)'
    s = { ...s, snapshotChosen: true, snapshotTried: true }
    if (!formOpenNow) {
      return act(s, {
        type: 'note',
        text: `Selected snapshot read back from the page URL: id=${urlSnapshot} name="${readName}".`,
      })
    }
  }
  for (let guard = 0; guard < 30; guard++) {
    if (s.submitted) {
      const id = locationIdFromUrl(snap.url)
      if (id && snap.url !== s.urlBeforeSubmit) {
        return done(s, { status: 'created', locationId: id, detail: missingNote(s) || `GHL opened the new sub-account (${id}).`, uncertain: false })
      }
      if (createSuccessCopy(snap)) {
        return done(s, {
          status: 'created',
          locationId: id,
        detail: `GHL confirmed "${input.fields.name}" was created. ${missingNote(s)}`.trim(),
          uncertain: !id,
        })
      }
      const listed = listedSubAccount(snap, input.fields.name)
      if (listed) {
        return done(s, {
          status: 'created',
          locationId: listed.locationId,
          detail: `Found "${input.fields.name}" in the sub-account list after Add Sub-Account.`,
          uncertain: !listed.locationId,
        })
      }
      if (!s.confirmListed && (s.postSubmitWaits >= 2 || !onForm(snap))) {
        return act(beginStep({ ...s, confirmListed: true }, 'open the sub-account list to confirm'), {
          type: 'goto',
          url: input.listUrl,
          settle: true,
        })
      }
      if ((!onForm(snap) && s.confirmListed && s.postSubmitWaits >= 2) || s.postSubmitWaits >= POST_SUBMIT_WAITS) {
        return done(s, {
          status: 'needs_human',
          locationId: id,
          uncertain: true,
          detail: `Clicked Add Sub-Account for "${input.fields.name}" but the page did not show a new location or the exact name in the list. ${onForm(snap) ? 'The details form was still open.' : 'The form had closed.'} ${missingNote(s)}`.trim(),
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
    if (isSnapshotModal(snap) && !s.snapshotChosen && !formOpen) {
      const choice = snapshotChoice(input.fields)
      if (!choice) {
        return done(s, {
          status: 'needs_human',
          locationId: null,
          uncertain: false,
          detail: 'The snapshot modal is open but the snapshot name is not known. Set GHL_SUBACCOUNT_SNAPSHOT_NAME to the card title, for example Master Template.',
        })
      }
      const picked = chooseSnapshotCard(snap.cards || [], snap.cardRefs, choice, input.fields.snapshotId)
      if (!picked.ok && picked.detail) {
        return done(s, {
          status: 'needs_human',
          locationId: null,
          uncertain: false,
          detail: `${picked.detail}\n${pageDiagnostics(snap)}`,
        })
      }
      if (picked.ok) {
        return act(beginStep({ ...s, snapshotChosen: true, snapshotTried: true, openedCreate: true }, `select snapshot ${picked.name}`), {
          type: 'select_card',
          name: picked.name,
          id: picked.id,
        })
      }
      const order = snapshotTabPlan(input.snapshotTab)
      const nextTab = order.find((tab) => !s.snapshotTabsTried.some((tried) => tabMatches(tried, tab)))
      if (nextTab) {
        const visible = [...(snap.tabs || []), ...snap.buttons].find((label) => tabMatches(label, nextTab))
        return act(beginStep({ ...s, snapshotTabsTried: [...s.snapshotTabsTried, nextTab], openedCreate: true }, `open tab ${nextTab}`), {
          type: 'click',
          words: [visible || nextTab],
          contains: true,
        })
      }
      const seen = (snap.cards || []).slice(0, 20).join(', ') || '(none)'
      return done(s, {
        status: 'needs_human',
        locationId: null,
        uncertain: false,
        detail: `Couldn't find a snapshot card named exactly "${choice}". Cards seen: ${seen}.\n${pageDiagnostics(snap)}`,
      })
    }

    const snapshotStep = !formOpen && !!fieldByKey(snap, 'snapshot') && (s.openedCreate || hasCreateButton(snap))
    if (formOpen && !s.formScrolled) {
      return act({ ...s, formScrolled: true }, { type: 'scroll_form' })
    }
    if (formOpen && accountName.warning && !s.nameWarned) {
      return act({ ...s, nameWarned: true }, { type: 'note', text: accountName.warning })
    }
    if (formOpen || snapshotStep) {
      if (formOpen) {
        for (const key of DETAIL_KEYS) {
          const value = input.fields[key]
          if (!value || s.filled.includes(key) || s.missing.includes(key)) continue
          const field = fieldByKey(snap, key)
          if (!field) {
            s = { ...s, missing: [...s.missing, key] }
            continue
          }
          if (norm(field.value) && !(key === 'name' && norm(field.value) !== norm(value))) {
            s = { ...s, filled: [...s.filled, key] }
            continue
          }
          const words = input.labels[key] ?? [key]
          if (isDropdownField(field) || ALWAYS_PICK.has(key)) {
            return act({ ...s, filled: [...s.filled, key] }, { type: 'pick', key, words, value })
          }
          return act({ ...s, filled: [...s.filled, key] }, { type: 'fill', key, words, value })
        }
      }
      if (!s.snapshotTried && !s.snapshotChosen) {
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
        if (!s.formRecorded) return act({ ...s, formRecorded: true }, { type: 'record_form' })
        const saveLabel = finalSaveLabel(snap)
        return done(s, {
          status: 'dry_run',
          locationId: null,
          uncertain: false,
          detail: `Reached the details form for "${input.fields.name}" and stopped before Create (${saveLabel}). ${accountName.warning ?? ''} ${fieldLabelNote(snap)} ${setNote(snap, input, s)} ${missingNote(s)} Set GHL_SUBACCOUNT_WORKER_MODE=create to press Create.`.replace(/\s+/g, ' ').trim(),
        })
      }
      const saveLabel = finalSaveLabel(snap)
      return act(
        { ...s, submitted: true, urlBeforeSubmit: snap.url },
        { type: 'click', words: saveLabel === '(no save button seen)' ? input.labels.submit : [saveLabel], exact: true },
      )
    }

    if (isBusinessSearch(snap) && !s.manualAdded) {
      return act(beginStep({ ...s, manualAdded: true, openedCreate: true }, 'click Add manually'), { type: 'add_manually' })
    }
    if (s.openedCreate && !s.choseSnapshot) {
      const choice = snapshotWizardButton(snap)
      if (choice) {
        return act(beginStep({ ...s, choseSnapshot: true }, 'choose snapshot'), {
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
      return act(beginStep({ ...s, stalls: s.stalls + 1 }, 'waiting for the create form'), { type: 'pause' })
    }

    // The left nav is the way in. Guessed URLs are only for when that item
    // is not on the page. /accounts/sub-accounts is a blank route, so it is
    // not one of them.
    if (!s.clickedNav && hasSubAccountsNav(snap) && !onSubAccountsPath(snap.url)) {
      return act(beginStep({ ...s, clickedNav: true }, 'click Sub-Accounts'), {
        type: 'click',
        words: input.labels.subAccountsNav ?? ['Sub-Accounts', 'Sub Accounts'],
        contains: true,
        settle: true,
      })
    }
    if (onSubAccountsPath(snap.url) && !isSubAccountListReady(snap) && !s.listWaited) {
      return act(beginStep({ ...s, listWaited: true, clickedNav: true }, 'wait for the sub-account list'), { type: 'wait_list' })
    }

    const createLabel = snap.buttons.find(isCreateSubAccountButton)
    if (createLabel && !s.openedCreate) {
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
      return act(beginStep({ ...s, openedCreate: true, wentToList: true }, 'click Create Sub-Account'), {
        type: 'click',
        words: [createLabel],
        exact: true,
        settle: 'modal',
      })
    }

    if (!onSubAccountsPath(snap.url) && (s.clickedNav || !hasSubAccountsNav(snap))) {
      const override = input.listUrlOverride?.trim() || ''
      if (override && !s.triedOverride && pathOf(snap.url) !== pathOf(override)) {
        return act(beginStep({ ...s, triedOverride: true, wentToList: true }, `open configured list ${override}`), {
          type: 'goto',
          url: override,
          settle: true,
        })
      }
      const candidates = listCandidates(input.listUrl)
      if (s.listGotos < candidates.length) {
        let i = s.listGotos
        while (i < candidates.length && pathOf(snap.url) === pathOf(candidates[i] || '')) i += 1
        const url = candidates[i]
        if (url) {
          return act(beginStep({ ...s, listGotos: i + 1, wentToList: true }, `open ${url}`), {
            type: 'goto',
            url,
            settle: true,
          })
        }
        s = { ...s, listGotos: i, wentToList: true }
      }
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
    return act(beginStep({ ...s, stalls: s.stalls + 1 }, 'still no create form'), { type: 'pause' })
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
  let observedSnapshotId: string | null = null
  let lastSnap: PageSnap | null = null
  const finish = (result: DriveResult): DriveResult => {
    const detail = state.trustNote && !result.detail.includes(state.trustNote) ? `${result.detail}\n${state.trustNote}` : result.detail
    return { ...result, detail, ...(reachedAgency ? { reachedAgency: true } : {}), ...(observedSnapshotId ? { observedSnapshotId } : {}) }
  }

  while (steps < maxSteps) {
    const snap = await io.snapshot()
    lastSnap = snap
    if (isAgencyHome(snap)) reachedAgency = true
    const seenSnapshot = snapshotIdFromUrl(snap.url)
    if (seenSnapshot) observedSnapshotId = seenSnapshot
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
      if (step.action.type === 'add_manually') {
        return finish({
          status: 'needs_human',
          locationId: null,
          uncertain: false,
          detail: `${message}\n${lastSnap ? pageDiagnostics(lastSnap) : ''}`,
        })
      }
      if (step.action.type === 'select_card') {
        return finish({
          status: 'needs_human',
          locationId: null,
          uncertain: false,
          detail: `${message}${lastSnap ? `\n${pageDiagnostics(lastSnap)}` : ''}`,
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
