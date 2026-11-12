/**
 * Playwright side of one customize run: for each Incoming Lead workflow,
 * open it in the client's sub-account, paste the Hub's prompt into GHL's
 * Workflow AI (the purple sparkle), wait for it, and press Save.
 *
 * The save is checked before it leaves the browser. GHL's builder sends
 * the workflow as JSON when Save is pressed; that request is held, read
 * (verify.ts), and let through only if every step the prompt names has
 * exactly the Hub's copy and recipient. Otherwise it is cancelled, the
 * unsaved edit is thrown away, and Workflow AI gets one more try.
 * After a save the workflow is opened again and checked as GHL stored it.
 *
 * Seen in GHL on 2026-11-12: the builder is an iframe named
 * "workflow-builder" (client-app-automation-workflows.leadconnectorhq.com);
 * Workflow AI applies its edit to the canvas unsaved and answers with
 * "Thought for …s"; the top-right button reads Save/Saved; saving a
 * published workflow asks nothing. Tests never import this file.
 */
import type { BrowserContext, Frame, Locator, Page, Request, Response, Route } from 'playwright'
import { capturePage, claimBrowser, newWorkerContext, releaseBrowser, signInOnPage } from '@/lib/ghl-subaccount-worker/browser'
import { chromiumLaunchArgs, prepareChromiumEnv } from '@/lib/ghl-subaccount-worker/chromium-host'
import type { GhlLabels } from '@/lib/ghl-subaccount-worker/labels'
import type { PageSnap } from '@/lib/ghl-subaccount-worker/plan'
import { WORKFLOW_FOLDERS, type WorkflowTask } from './copy'
import { aiDeclined } from './eligibility'
import { failureSamples, findNamedNodes, stepNameChanges, verifyWorkflowJson, type WorkflowCheck } from './verify'

export type WorkflowOutcome = {
  id: string
  name: string
  /**
   * done: saved, and checked. already: it had the copy, nothing to do.
   * rehearsed: dry-run mode, the edit matched and was not saved.
   * needs_human: GHL or Workflow AI can't do it as asked. error: may work on a retry.
   */
  status: 'done' | 'already' | 'rehearsed' | 'needs_human' | 'error'
  workflowId?: string
  detail: string
}

export type CustomizeBrowserOptions = {
  locationId: string
  clientName: string
  tasks: WorkflowTask[]
  /** false = dry run: everything up to the save, which is cancelled. */
  save: boolean
  labels: GhlLabels
  login: { email: string; password: string } | null
  storageState: string | null
  headless: boolean
  executablePath?: string
  signal?: AbortSignal
  pullOtp: (waitMs: number) => Promise<string | null>
  onOtpPrompt: (detail: string) => Promise<void>
  onNote: (line: string) => Promise<void>
  capture: (step: string, image: Buffer) => Promise<void>
  onOutcome: (outcome: WorkflowOutcome) => Promise<void>
}

export type CustomizeBrowserResult = {
  outcomes: WorkflowOutcome[]
  /** The run stopped before the workflows (the sign-in). */
  stopped?: { status: 'needs_human' | 'error'; detail: string }
  storageState: string | null
}

const APP = 'https://app.gohighlevel.com'
const BUILDER_FRAME = /automation-workflows/i
const WORKFLOW_IN_URL = /\/automation\/workflow\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
/** Where GHL's workflow data comes from (read for the checks). */
const BACKEND_HOST = /(^|\.)(leadconnectorhq\.com|gohighlevel\.com|msgsndr\.com)$/i
/** Where the builder saves to. The app's own host only sends page analytics, which are never held. */
const SAVE_HOST = /(^|\.)(leadconnectorhq\.com|msgsndr\.com)$/i
const TELEMETRY = /\/(_pm|cdn-cgi)\/|\b(rum|analytics|telemetry|track|tracking|sentry|logs?)\b/i
const AI_INPUT = 'textarea[placeholder*="change" i]'
const WORKING = /^\s*Working[\s.…•·]*$/
/** Workflow AI took about a minute in the test; give it room. */
const AI_WAIT_MS = 5 * 60_000
const DIALOG = '[role="dialog"], [aria-modal="true"], .n-modal, .modal, .hl-modal'
/** Buttons that only close an announcement or a prompt. Pressed only inside a dialog. */
const DISMISS = ['Continue with Manual Save', 'Got it', 'Got It', 'Close', 'Skip', 'Maybe later', 'Maybe Later', 'Dismiss', 'Not now', 'No thanks']

/** Something a retry won't fix (needs_human) or might (error). */
class Halt extends Error {
  constructor(
    readonly status: 'needs_human' | 'error',
    message: string,
  ) {
    super(message)
  }
}

export function workflowsUrl(locationId: string): string {
  return `${APP}/v2/location/${locationId}/automation/workflows`
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new Error('The job ran out of time.'))
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const clip = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat
}

function shortUrl(raw: string): string {
  try {
    const u = new URL(raw)
    return `${u.host}${u.pathname}`.slice(0, 160)
  } catch {
    return raw.slice(0, 160)
  }
}

/** Any GHL app page past the login (a location, the agency dashboard or list). */
function signedInPage(snap: PageSnap): boolean {
  try {
    const u = new URL(snap.url)
    if (!/(gohighlevel|leadconnectorhq)\.com$/i.test(u.hostname)) return false
    return /^\/(v2\/location\/|location\/|agency_dashboard|sub-accounts|agency\/|accounts)/i.test(u.pathname)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// The workflow JSON GHL sends to the builder
// ---------------------------------------------------------------------------

type Captured = { at: number; url: string; json: unknown }

/** Keeps the recent JSON responses that name the current workflow's steps. */
class WorkflowCapture {
  private items: Captured[] = []
  names: string[] = []

  attach(context: BrowserContext): void {
    context.on('response', (res) => {
      void this.take(res)
    })
  }

  private async take(res: Response): Promise<void> {
    try {
      if (!this.names.length) return
      const type = res.request().resourceType()
      if (type !== 'xhr' && type !== 'fetch') return
      if (!BACKEND_HOST.test(new URL(res.url()).hostname)) return
      if (!(res.headers()['content-type'] || '').includes('json')) return
      const text = await res.text()
      if (text.length > 4_000_000 || !this.names.some((n) => text.includes(n))) return
      this.items.push({ at: Date.now(), url: res.url(), json: JSON.parse(text) as unknown })
      if (this.items.length > 12) this.items.shift()
    } catch {
      // Redirects, aborted requests and non-JSON bodies can't be read; they aren't the workflow.
    }
  }

  /** The payload since `since` that names the most of these steps (newest wins a tie). */
  private best(since: number, names: string[]): { item: Captured; score: number } | null {
    let pick: { item: Captured; score: number } | null = null
    for (const item of this.items) {
      if (item.at < since) continue
      const score = findNamedNodes(item.json, names).size
      if (score && (!pick || score >= pick.score)) pick = { item, score }
    }
    return pick
  }

  async waitFor(since: number, names: string[], timeoutMs: number, signal?: AbortSignal): Promise<Captured | null> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const pick = this.best(since, names)
      if (pick && pick.score >= names.length) return pick.item
      if (Date.now() >= deadline) return pick?.item ?? null
      await sleep(500, signal)
    }
  }
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function builderFrame(page: Page, signal?: AbortSignal, timeoutMs = 45_000): Promise<Frame | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const frame = page.frames().find((f) => f !== page.mainFrame() && (f.name() === 'workflow-builder' || BUILDER_FRAME.test(f.url())))
    if (frame && /^https?:/i.test(frame.url())) return frame
    if (Date.now() >= deadline) return null
    await sleep(500, signal)
  }
}

async function visibleIn(loc: Locator): Promise<Locator | null> {
  const n = await loc.count().catch(() => 0)
  for (let i = 0; i < Math.min(n, 25); i++) {
    const item = loc.nth(i)
    if (await item.isVisible().catch(() => false)) return item
  }
  return null
}

async function waitVisible(loc: Locator, timeoutMs: number, signal?: AbortSignal): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = await visibleIn(loc)
    if (hit) return hit
    if (Date.now() >= deadline) return null
    await sleep(400, signal)
  }
}

async function passwordShowing(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    if (await visibleIn(frame.locator('input[type="password"]'))) return true
  }
  return false
}

/** After opening a location page: the workflow app loaded (signed in), or GHL wants a login. */
async function appOrLogin(page: Page, signal?: AbortSignal): Promise<'app' | 'login'> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (await passwordShowing(page)) return 'login'
    if (await builderFrame(page, signal, 0)) return 'app'
    await sleep(700, signal)
  }
  return 'login'
}

async function frameText(frame: Frame): Promise<string> {
  return frame.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '')
}

/** Close a GHL announcement or the auto-save question. Only buttons inside a dialog are pressed. */
async function dismissPopups(frame: Frame, note: (line: string) => Promise<void>): Promise<void> {
  const manual = await visibleIn(frame.getByText('Continue with Manual Save', { exact: true }))
  if (manual) {
    await manual.click({ timeout: 5000 }).catch(() => {})
    await note('Chose "Continue with Manual Save" on GHL\'s auto-save question.')
    await sleep(700)
  }
  for (const label of DISMISS) {
    const hit = await visibleIn(frame.locator(DIALOG).getByRole('button', { name: label, exact: true }))
    if (!hit) continue
    await hit.click({ timeout: 5000 }).catch(() => {})
    await note(`Closed a GHL pop-up with "${label}".`)
    await sleep(700)
  }
}

type SaveState = 'save' | 'saved' | 'saving' | null

async function saveStateOf(frame: Frame): Promise<SaveState> {
  return frame
    .evaluate(() => {
      for (const b of Array.from(document.querySelectorAll('button'))) {
        const r = b.getBoundingClientRect()
        if (!r.width || !r.height) continue
        const t = (b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
        if (t === 'saved') return 'saved' as const
        if (t === 'save') return (b as HTMLButtonElement).disabled ? ('saved' as const) : ('save' as const)
        if (t.startsWith('saving')) return 'saving' as const
      }
      return null
    })
    .catch(() => null)
}

/** The builder's top-right Save button, wherever GHL renders it: 'save' when there is something to save. */
async function saveState(page: Page): Promise<SaveState> {
  for (const frame of page.frames()) {
    const state = await saveStateOf(frame)
    if (state) return state
  }
  return null
}

async function clickSave(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    const hit = await visibleIn(frame.locator('button').filter({ hasText: /^\s*Save\s*$/ }))
    if (!hit) continue
    await hit.click({ timeout: 8000 })
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Workflow AI
// ---------------------------------------------------------------------------

async function aiInput(frame: Frame): Promise<Locator | null> {
  return visibleIn(frame.locator(AI_INPUT))
}

/** Open the Workflow AI panel: a control labelled for it, else the toolbar icon whose tooltip says so, else ⇧A. */
async function openAi(frame: Frame, signal?: AbortSignal): Promise<Locator> {
  const open = await aiInput(frame)
  if (open) return open
  const labelled = await visibleIn(
    frame.locator('[aria-label*="workflow ai" i], [title*="workflow ai" i], [data-tooltip*="workflow ai" i], [data-title*="workflow ai" i], [data-testid*="workflow-ai" i], [id*="workflow-ai" i]'),
  )
  if (labelled) {
    await labelled.click({ timeout: 5000 }).catch(() => {})
    const input = await waitVisible(frame.locator(AI_INPUT), 8000, signal)
    if (input) return input
  }
  // The left toolbar's icons, bottom first (Workflow AI is the last one).
  const icons = frame.locator('button, [role="button"]')
  const order = await frame
    .evaluate(() =>
      Array.from(document.querySelectorAll('button, [role="button"]'))
        .map((el, i) => {
          const r = el.getBoundingClientRect()
          return { i, x: r.left, y: r.top, w: r.width, h: r.height }
        })
        .filter((b) => b.w > 10 && b.w <= 64 && b.h > 10 && b.h <= 64 && b.x < 90)
        .sort((a, b) => b.y - a.y)
        .map((b) => b.i),
    )
    .catch(() => [] as number[])
  for (const i of order.slice(0, 12)) {
    const icon = icons.nth(i)
    await icon.hover({ timeout: 2000 }).catch(() => {})
    await sleep(450, signal)
    if (await visibleIn(frame.getByText(/^\s*Workflow AI/))) {
      await icon.click({ timeout: 5000 }).catch(() => {})
      const input = await waitVisible(frame.locator(AI_INPUT), 8000, signal)
      if (input) return input
    }
  }
  await frame.locator('body').press('Shift+A').catch(() => {})
  const input = await waitVisible(frame.locator(AI_INPUT), 8000, signal)
  if (input) return input
  throw new Halt('error', "Couldn't open Workflow AI in the builder (no purple sparkle button found).")
}

/** A fresh conversation in Build mode, so an earlier try doesn't steer this one. */
async function freshConversation(frame: Frame, signal?: AbortSignal): Promise<void> {
  const clear = await visibleIn(frame.getByText('Clear chat', { exact: true }))
  if (clear) {
    await clear.click({ timeout: 5000 }).catch(() => {})
    await sleep(800, signal)
    for (const label of ['Clear', 'Clear chat', 'Yes', 'Confirm', 'Continue']) {
      const confirm = await visibleIn(frame.locator(DIALOG).getByRole('button', { name: label, exact: true }))
      if (confirm) {
        await confirm.click({ timeout: 5000 }).catch(() => {})
        await sleep(800, signal)
        break
      }
    }
  }
  const build = await visibleIn(frame.getByText('Build', { exact: true }))
  if (build) await build.click({ timeout: 3000 }).catch(() => {})
}

async function working(frame: Frame): Promise<boolean> {
  return !!(await visibleIn(frame.getByText(WORKING)))
}

async function thoughtCount(frame: Frame): Promise<number> {
  return ((await frameText(frame)).match(/Thought for\s+[\d.]+\s*s/gi) || []).length
}

async function sendButton(box: Locator): Promise<Locator | null> {
  const buttons = box.locator('xpath=ancestor::*[descendant::button][1]').locator('button')
  const n = await buttons.count().catch(() => 0)
  for (let i = n - 1; i >= 0; i--) {
    const b = buttons.nth(i)
    if ((await b.isVisible().catch(() => false)) && (await b.isEnabled().catch(() => false))) return b
  }
  return null
}

/** Paste the prompt, send it, and wait for Workflow AI's answer. */
async function askAi(page: Page, frame: Frame, prompt: string, signal?: AbortSignal): Promise<{ changed: boolean; reply: string }> {
  await openAi(frame, signal)
  await freshConversation(frame, signal)
  const box = (await waitVisible(frame.locator(AI_INPUT), 8000, signal)) ?? null
  if (!box) throw new Halt('error', "Workflow AI's message box didn't show.")
  const before = await thoughtCount(frame)
  await box.click({ timeout: 5000 })
  await box.fill(prompt)
  const typed = await box.inputValue().catch(() => '')
  if (typed.trim() !== prompt.trim()) {
    throw new Halt('error', `The prompt didn't go into Workflow AI's box in full (${typed.length} of ${prompt.length} characters).`)
  }
  await box.press('Enter')
  let started = await waitVisible(frame.getByText(WORKING), 8000, signal)
  if (!started && (await box.inputValue().catch(() => '')).trim()) {
    // Enter added a line instead of sending: press the send arrow beside the box.
    const send = await sendButton(box)
    if (send) await send.click({ timeout: 5000 }).catch(() => {})
    started = await waitVisible(frame.getByText(WORKING), 8000, signal)
  }
  if (!started && (await box.inputValue().catch(() => '')).trim()) {
    throw new Halt('error', "Workflow AI didn't take the prompt (it stayed in the box).")
  }
  const deadline = Date.now() + AI_WAIT_MS
  let quiet = 0
  for (;;) {
    await sleep(2000, signal)
    const busy = await working(frame)
    const answered = (await thoughtCount(frame)) > before
    quiet = busy ? 0 : quiet + 1
    if ((answered && !busy) || quiet >= 8) break
    if (Date.now() >= deadline) throw new Halt('error', `Workflow AI was still working after ${Math.round(AI_WAIT_MS / 60_000)} minutes.`)
  }
  await sleep(1500, signal)
  const text = await frameText(frame)
  const at = text.lastIndexOf('Thought for')
  const reply = at >= 0 ? text.slice(at, at + 2500) : text.slice(-1500)
  return { changed: (await saveState(page)) === 'save', reply }
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

type Run = {
  opts: CustomizeBrowserOptions
  context: BrowserContext
  page: Page
  capture: WorkflowCapture
  note: (line: string) => Promise<void>
  shoot: (step: string) => Promise<void>
}

async function sessionOf(context: BrowserContext): Promise<string | null> {
  try {
    return JSON.stringify(await context.storageState())
  } catch {
    return null
  }
}

async function newPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)
  // "Leave site?" after a cancelled save means leave: the edit was not saved on purpose.
  page.on('dialog', (d) => {
    void d.accept().catch(() => {})
  })
  return page
}

/** Throw away an unsaved edit: close the tab without asking, and work in a new one. */
async function freshPage(run: Run): Promise<void> {
  const old = run.page
  run.page = await newPage(run.context)
  await old.close({ runBeforeUnload: false }).catch(() => {})
}

async function ensureSignedIn(run: Run): Promise<void> {
  const { opts } = run
  await run.page.goto(workflowsUrl(opts.locationId), { waitUntil: 'domcontentloaded', timeout: 60_000 })
  if ((await appOrLogin(run.page, opts.signal)) === 'app') return
  await run.note('GHL asked to sign in. Signing in with the agency login.')
  const res = await signInOnPage(run.page, {
    label: `${opts.clientName}'s lead workflows`,
    homeUrl: workflowsUrl(opts.locationId),
    labels: opts.labels,
    login: opts.login,
    pullOtp: opts.pullOtp,
    onOtpPrompt: opts.onOtpPrompt,
    onNote: run.note,
    capture: opts.capture,
    isSignedIn: signedInPage,
    signal: opts.signal,
  })
  if (res.status !== 'signed_in') throw new Halt(res.status === 'failed' ? 'error' : 'needs_human', res.detail)
  await run.note(res.detail)
}

async function openWorkflow(run: Run, task: WorkflowTask): Promise<string> {
  const { page } = run
  const signal = run.opts.signal
  await page.goto(workflowsUrl(run.opts.locationId), { waitUntil: 'domcontentloaded', timeout: 60_000 })
  if ((await appOrLogin(page, signal)) === 'login') {
    await ensureSignedIn(run)
    await page.goto(workflowsUrl(run.opts.locationId), { waitUntil: 'domcontentloaded', timeout: 60_000 })
  }
  const frame = await builderFrame(page, signal)
  if (!frame) throw new Halt('error', "GHL's workflow list didn't load.")
  await dismissPopups(frame, run.note)
  // Home → Client Workflows → Incoming Lead Workflows → the workflow.
  if (!(await waitVisible(frame.getByText(task.name, { exact: true }), 3000, signal))) {
    for (const folder of WORKFLOW_FOLDERS) {
      const hit = await waitVisible(frame.getByText(folder, { exact: true }), 30_000, signal)
      if (!hit) {
        throw new Halt('needs_human', `The sub-account's workflow list has no "${folder}" folder, so "${task.name}" couldn't be found. The snapshot may not have loaded fully.`)
      }
      await hit.click({ timeout: 8000 })
      await sleep(1500, signal)
    }
  }
  const rows = frame.getByText(task.name, { exact: true })
  const row = await waitVisible(rows, 30_000, signal)
  if (!row) throw new Halt('needs_human', `There's no workflow named "${task.name}" in ${WORKFLOW_FOLDERS.join(' → ')}.`)
  let shown = 0
  for (let i = 0; i < Math.min(await rows.count(), 10); i++) if (await rows.nth(i).isVisible().catch(() => false)) shown += 1
  if (shown > 1) throw new Halt('needs_human', `Two workflows are named "${task.name}" in ${WORKFLOW_FOLDERS.join(' → ')}, so the Hub didn't pick one.`)
  await row.click({ timeout: 8000 })
  const deadline = Date.now() + 45_000
  for (;;) {
    const id = WORKFLOW_IN_URL.exec(page.url())?.[1]
    if (id) return id
    if (Date.now() >= deadline) throw new Halt('error', `Clicked "${task.name}" but its builder didn't open.`)
    await sleep(500, signal)
  }
}

/** Wait for the builder: its Save/Saved button and a settled canvas. */
async function waitForBuilder(run: Run, task: WorkflowTask): Promise<Frame> {
  const signal = run.opts.signal
  const deadline = Date.now() + 60_000
  for (;;) {
    const frame = await builderFrame(run.page, signal, 5000)
    if (frame) {
      await dismissPopups(frame, run.note)
      if (await saveState(run.page)) {
        await sleep(2000, signal)
        await dismissPopups(frame, run.note)
        return frame
      }
    }
    if (Date.now() >= deadline) throw new Halt('error', `The "${task.name}" builder didn't finish loading.`)
    await sleep(700, signal)
  }
}

/**
 * saved: GHL stored it (checked = the steps were seen and matched on the
 * way out; null = the save didn't carry them, so only the reopen can check).
 * blocked: nothing was stored.
 */
type SaveResult = { status: 'saved' | 'blocked' | 'rehearsed'; detail: string; checked: WorkflowCheck | null }

/**
 * Press Save with the requests held: one that carries these steps is
 * checked and only goes through if they match. A request to the workflow's
 * own address that doesn't carry them waits for that check; if it comes
 * first, it is stopped and nothing is saved.
 */
async function saveChecked(run: Run, task: WorkflowTask, workflowId: string): Promise<SaveResult> {
  const st: { seen: string[]; passed: WorkflowCheck | null; blocked: string } = { seen: [], passed: null, blocked: '' }
  const handler = async (route: Route, request: Request) => {
    try {
      const method = request.method()
      const url = request.url()
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS' || TELEMETRY.test(url)) return await route.continue()
      const body = request.postData() ?? ''
      const named = task.actions.some((a) => body.includes(a.name))
      if (!named && !url.includes(workflowId)) return await route.continue()
      if (!named) {
        st.seen.push(`${method} ${shortUrl(url)} (${body.length} bytes, no steps in it): ${st.passed ? 'let through' : 'stopped, the steps were not checked yet'}`)
        if (st.passed && run.opts.save) return await route.continue()
        if (!st.passed) st.blocked ||= `GHL sent part of the save (${shortUrl(url)}) before the steps could be checked, so it was stopped.`
        return await route.abort('failed')
      }
      let json: unknown = null
      try {
        json = JSON.parse(body) as unknown
      } catch {
        json = null
      }
      const check = json === null ? null : verifyWorkflowJson(json, task.actions)
      st.seen.push(`${method} ${shortUrl(url)} (${body.length} bytes): ${check ? check.summary : `not JSON the Hub can read: ${clip(body, 400)}`}`)
      if (check && !check.ok) st.seen.push(`What GHL was about to save: ${failureSamples(json, check)}`)
      if (!check || !check.ok) {
        st.blocked ||= check ? check.summary : `the save (${shortUrl(url)}) wasn't JSON the Hub can read`
        return await route.abort('failed')
      }
      st.passed = check
      if (!run.opts.save) return await route.abort('failed')
      return await route.continue()
    } catch {
      await route.abort('failed').catch(() => {})
    }
  }
  const matcher = (url: URL) => SAVE_HOST.test(url.hostname)
  await run.context.route(matcher, handler)
  let finalState: Awaited<ReturnType<typeof saveState>> = null
  try {
    if (!(await clickSave(run.page))) return { status: 'blocked', detail: "Couldn't find the Save button.", checked: null }
    const deadline = Date.now() + 45_000
    for (;;) {
      await sleep(600, run.opts.signal)
      finalState = await saveState(run.page)
      if (st.blocked) break
      if (!run.opts.save && st.passed) break
      if (finalState === 'saved') break
      if (Date.now() >= deadline) break
    }
    // A last request can still be on its way when the button flips.
    await sleep(1500, run.opts.signal)
    finalState = await saveState(run.page)
  } finally {
    await run.context.unroute(matcher, handler).catch(() => {})
  }
  await run.note(`Save of "${task.name}": ${st.seen.length ? st.seen.join(' | ') : 'no request that names the workflow or its steps was seen'}. The button reads ${finalState ?? '(not found)'}.`)
  if (st.blocked) return { status: 'blocked', detail: st.blocked, checked: null }
  if (!run.opts.save && st.passed) return { status: 'rehearsed', detail: st.passed.summary, checked: st.passed }
  if (finalState !== 'saved') {
    return { status: 'blocked', detail: st.passed ? 'The steps matched, but GHL never showed "Saved".' : 'GHL never showed "Saved".', checked: st.passed }
  }
  if (!st.passed) return { status: 'saved', detail: "GHL saved it without sending the steps' text, so it is checked by reopening it", checked: null }
  return { status: 'saved', detail: st.passed.summary, checked: st.passed }
}

/** The data names the steps but carries none of their messages (a list, not the workflow itself). */
function withoutText(check: WorkflowCheck): boolean {
  return check.checks.every((c) => c.ok || c.problem === 'the step has no message')
}

async function customizeOne(run: Run, task: WorkflowTask): Promise<WorkflowOutcome> {
  const names = task.actions.map((a) => a.name)
  const signal = run.opts.signal
  run.capture.names = names
  const base = { id: task.id, name: task.name }
  let before: Captured | null = null
  let workflowId = ''
  let lastProblem = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) await freshPage(run)
    const openedAt = Date.now()
    workflowId = await openWorkflow(run, task)
    let frame = await waitForBuilder(run, task)
    // The workflow as GHL loaded it: maybe it already has the copy (or an earlier try saved it).
    const loaded = await run.capture.waitFor(openedAt, names, 15_000, signal)
    if (attempt === 1) before = loaded
    if (loaded) {
      const check = verifyWorkflowJson(loaded.json, task.actions)
      await run.note(`"${task.name}" (${workflowId}) as it opened (${shortUrl(loaded.url)}): ${check.summary}.`)
      if (!check.ok && attempt === 1) await run.note(`How GHL stores it: ${failureSamples(loaded.json, check)}`)
      if (check.ok) {
        return attempt === 1
          ? { ...base, status: 'already', workflowId, detail: "It already had the Hub's copy, so Workflow AI wasn't needed." }
          : { ...base, status: 'done', workflowId, detail: `Saved on the first try after all: ${check.summary}.` }
      }
      const missing = check.checks.filter((c) => c.problem === 'the step is not in the workflow').map((c) => `"${c.name}"`)
      if (missing.length) {
        return { ...base, status: 'needs_human', workflowId, detail: `The workflow has no step named ${missing.join(', ')}, so nothing was changed. Rename the step in GHL or set it up by hand.` }
      }
    } else {
      await run.note(`Couldn't read "${task.name}" as it opened; the steps are checked when Save is pressed.`)
    }
    const ai = await askAi(run.page, frame, task.prompt, signal)
    await run.note(`Workflow AI on "${task.name}" (try ${attempt}): ${ai.changed ? 'it changed the workflow' : 'it changed nothing'}. It said: ${clip(ai.reply, 1200)}`)
    await run.shoot(`workflow ai ${task.id} try ${attempt}`)
    if (!ai.changed) {
      lastProblem = `Workflow AI changed nothing. It said: ${clip(ai.reply, 300)}`
      if (aiDeclined(ai.reply)) return { ...base, status: 'needs_human', workflowId, detail: lastProblem }
      continue
    }
    const saved = await saveChecked(run, task, workflowId)
    if (saved.status === 'rehearsed') return { ...base, status: 'rehearsed', workflowId, detail: `Dry run: ${saved.detail}. Nothing was saved.` }
    if (saved.status === 'blocked') {
      lastProblem = `Nothing was saved: ${saved.detail}`
      await run.shoot(`save blocked ${task.id} try ${attempt}`)
      continue
    }
    // Saved: open it again and check it as GHL stored it.
    const reloadAt = Date.now()
    await run.page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
    frame = await waitForBuilder(run, task)
    const after = await run.capture.waitFor(reloadAt, names, 20_000, signal)
    if (!after) {
      if (!saved.checked) {
        return { ...base, status: 'needs_human', workflowId, detail: "Saved, but the Hub couldn't read it back to check it. Open it in GHL and check the messages." }
      }
      return { ...base, status: 'done', workflowId, detail: `Saved; ${saved.detail} (checked on save; GHL didn't send it back on reopening).` }
    }
    const stored = verifyWorkflowJson(after.json, task.actions)
    if (!stored.ok && saved.checked && withoutText(stored)) {
      return { ...base, status: 'done', workflowId, detail: `Saved; ${saved.detail} (checked on save; reopened, GHL lists the steps without their text).` }
    }
    if (!stored.ok) {
      return { ...base, status: 'needs_human', workflowId, detail: `Saved, but reopened it doesn't match the Hub's copy: ${stored.summary}. Check it in GHL.` }
    }
    // Steps added or removed (Workflow AI is told not to): only comparable when both loads came from the same address.
    const changes = before && shortUrl(before.url) === shortUrl(after.url) ? stepNameChanges(before.json, after.json) : null
    if (changes && (changes.added.length || changes.removed.length)) {
      const what = [changes.added.length ? `added ${changes.added.join(', ')}` : '', changes.removed.length ? `removed ${changes.removed.join(', ')}` : ''].filter(Boolean).join('; ')
      return { ...base, status: 'needs_human', workflowId, detail: `Saved with the Hub's copy, but the workflow's steps changed (${what}). Check it in GHL.` }
    }
    return { ...base, status: 'done', workflowId, detail: `Saved and reopened: ${stored.summary}.` }
  }
  return { ...base, status: 'needs_human', workflowId, detail: `Two tries, nothing saved. ${lastProblem}` }
}

export async function runCustomizeInBrowser(opts: CustomizeBrowserOptions): Promise<CustomizeBrowserResult> {
  if (opts.signal?.aborted) throw new Error('The job ran out of time.')
  claimBrowser()
  let context: BrowserContext | null = null
  let close: (() => Promise<void>) | null = null
  const outcomes: WorkflowOutcome[] = []
  try {
    prepareChromiumEnv()
    const pw = (await import('playwright')) as typeof import('playwright')
    const browser = await pw.chromium.launch({ headless: opts.headless, executablePath: opts.executablePath || undefined, args: chromiumLaunchArgs() })
    close = () => browser.close()
    opts.signal?.addEventListener('abort', () => void browser.close().catch(() => {}), { once: true })
    context = await newWorkerContext(browser, opts.storageState)
    const capture = new WorkflowCapture()
    capture.attach(context)
    const run: Run = {
      opts,
      context,
      page: await newPage(context),
      capture,
      note: async (line) => {
        await opts.onNote(line).catch(() => {})
      },
      shoot: async (step) => {
        try {
          await opts.capture(step, await capturePage(run.page))
        } catch {
          // A missing picture never stops the run.
        }
      },
    }
    try {
      await ensureSignedIn(run)
    } catch (err) {
      if (!(err instanceof Halt)) throw err
      await run.shoot('failure sign-in')
      return { outcomes, stopped: { status: err.status, detail: err.message }, storageState: await sessionOf(context) }
    }
    for (const task of opts.tasks) {
      let outcome: WorkflowOutcome
      try {
        outcome = await customizeOne(run, task)
      } catch (err) {
        if (opts.signal?.aborted) throw err
        await run.shoot(`failure ${task.id}`)
        const detail = err instanceof Error ? err.message : String(err)
        outcome = { id: task.id, name: task.name, status: err instanceof Halt ? err.status : 'error', detail }
        await freshPage(run).catch(() => {})
      }
      outcomes.push(outcome)
      await opts.onOutcome(outcome)
    }
    return { outcomes, storageState: await sessionOf(context) }
  } finally {
    await context?.close().catch(() => {})
    await close?.().catch(() => {})
    releaseBrowser()
  }
}
