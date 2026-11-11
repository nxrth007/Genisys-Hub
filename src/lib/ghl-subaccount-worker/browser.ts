/**
 * Playwright side of one create. The decisions are in plan.ts; this
 * file only launches Chromium, keeps the session, and performs the
 * action the planner asked for. Tests never import it.
 */
import type { Browser, BrowserContext, Frame, Page } from 'playwright'
import { chromiumLaunchArgs, prepareChromiumEnv } from './chromium-host'
import type { BrowserFields } from './fields'
import type { GhlLabels } from './labels'
import { driveUntil, type BrowserAction, type DriveResult, type PageSnap } from './plan'
import { GHL_PAGE_SOURCE } from './page-source'

/** One Chromium at a time. A second launch would sit on top of the Hub's memory. */
let browserOpen = false

export type BrowserRunOptions = {
  fields: BrowserFields
  mode: 'dry_run' | 'create'
  labels: GhlLabels
  listUrl: string
  login: { email: string; password: string } | null
  /** Playwright storageState JSON from the last successful session, or null. */
  storageState: string | null
  pullOtp: (waitMs: number) => Promise<string | null>
  onOtpPrompt: (detail: string) => Promise<void>
  headless: boolean
  executablePath?: string
  signal?: AbortSignal
}

export type BrowserRunResult = DriveResult & { storageState: string | null }

type CommandResult = { ok?: boolean; retry?: boolean; error?: string; url?: string; fields?: unknown }

const EMPTY_SNAP: PageSnap = { url: '', fields: [], buttons: [], texts: [], links: [], body: '' }

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

function score(snap: PageSnap): number {
  let n = snap.fields.length
  if (snap.fields.some((f) => f.key === 'name')) n += 20
  if (snap.fields.some((f) => f.key === 'password' || f.type === 'password')) n += 15
  if (snap.fields.some((f) => f.key === 'otp')) n += 15
  if (snap.buttons.some((b) => /create sub-account|create account/.test(b))) n += 8
  return n
}

async function runCommand(frame: Frame, cmd: Record<string, unknown>): Promise<CommandResult> {
  const expr = `(${GHL_PAGE_SOURCE})(${JSON.stringify(cmd)})`
  return (await frame.evaluate(expr)) as CommandResult
}

async function snapshotPage(page: Page, labels: GhlLabels): Promise<PageSnap> {
  let best: PageSnap | null = null
  for (const frame of page.frames()) {
    try {
      const snap = (await runCommand(frame, { op: 'snapshot', labels })) as PageSnap
      if (snap && Array.isArray(snap.fields) && (!best || score(snap) > score(best))) best = snap
    } catch {
      // A frame can be navigating, or be a cross-origin embed we can't read.
    }
  }
  if (best) return best
  return { ...EMPTY_SNAP, url: page.url() }
}

async function runAcrossFrames(page: Page, cmd: Record<string, unknown>): Promise<{ ok?: boolean; error?: string } | null> {
  let last: { ok?: boolean; error?: string } | null = null
  for (const frame of page.frames()) {
    try {
      const res = await runCommand(frame, cmd)
      if (res?.ok) return res
      if (res) last = res
    } catch (err) {
      last = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
  return last
}

async function performAction(
  page: Page,
  action: BrowserAction,
  labels: GhlLabels,
  secrets: { password: string; otp: string },
  signal?: AbortSignal,
): Promise<void> {
  if (action.type === 'pause') {
    await sleep(900, signal)
    return
  }
  if (action.type === 'goto') {
    await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await sleep(800, signal)
    return
  }
  if (action.type === 'wait_otp' || action.type === 'press_enter') {
    if (action.type === 'press_enter') {
      await runAcrossFrames(page, { op: 'pressEnter', labels })
    }
    return
  }
  if (action.type === 'remember') {
    await runAcrossFrames(page, { op: 'remember', labels })
    await sleep(300, signal)
    return
  }
  if (action.type === 'fill_otp') {
    const cmd = { op: 'fillOtp', value: secrets.otp, labels }
    const res = await runAcrossFrames(page, cmd)
    if (!res?.ok) throw new Error(res?.error || 'No code box on the page')
    await sleep(400, signal)
    return
  }
  if (action.type === 'click_verify') {
    await runAcrossFrames(page, { op: 'clickVerify', words: action.words, labels })
    await sleep(900, signal)
    return
  }

  const value =
    action.type === 'fill' && action.key === 'password'
      ? secrets.password
      : action.type === 'fill' && action.key === 'otp'
        ? secrets.otp
        : action.type === 'fill'
          ? action.value
          : action.type === 'pick'
            ? action.value
            : undefined
  const cmd = {
    op: action.type,
    key: 'key' in action ? action.key : undefined,
    words: 'words' in action ? action.words : [],
    exact: 'exact' in action ? action.exact : false,
    value,
    labels,
  }
  const tries = action.type === 'pick' ? 4 : 1
  let last = 'Could not do that on the page.'
  for (let attempt = 0; attempt < tries; attempt++) {
    if (signal?.aborted) throw new Error('The job ran out of time.')
    for (const frame of page.frames()) {
      try {
        const res = await runCommand(frame, cmd)
        if (res?.ok) {
          await sleep(action.type === 'click' ? 900 : 250, signal)
          return
        }
        if (res?.error) last = res.error
        if (res?.retry) break
      } catch (err) {
        last = err instanceof Error ? err.message : String(err)
      }
    }
    if (attempt + 1 < tries) await sleep(400, signal)
  }
  throw new Error(last)
}

function parseStorage(raw: string | null): unknown {
  if (!raw?.trim()) return undefined
  try {
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object') return undefined
    return v
  } catch {
    return undefined
  }
}

export async function runCreateInBrowser(opts: BrowserRunOptions): Promise<BrowserRunResult> {
  if (opts.signal?.aborted) throw new Error('The job ran out of time.')
  if (browserOpen) throw new Error('A browser is already open. The worker runs one Chromium at a time and closes it when the job finishes.')
  browserOpen = true
  prepareChromiumEnv()
  const pw = (await import('playwright')) as typeof import('playwright')
  let browser: Browser | null = null
  let context: BrowserContext | null = null
  const secrets = { password: opts.login?.password ?? '', otp: '' }
  try {
    browser = await pw.chromium.launch({
      headless: opts.headless,
      executablePath: opts.executablePath || undefined,
      args: chromiumLaunchArgs(),
    })
    const onAbort = () => {
      void browser?.close().catch(() => {})
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    context = await browser.newContext({
      storageState: parseStorage(opts.storageState) as Awaited<ReturnType<BrowserContext['storageState']>> | undefined,
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(20_000)
    const result = await driveUntil(
      {
        snapshot: () => snapshotPage(page, opts.labels),
        perform: (action) => performAction(page, action, opts.labels, secrets, opts.signal),
        pullOtp: async (waitMs) => {
          const code = await opts.pullOtp(waitMs)
          if (code) secrets.otp = code
          return code
        },
        onOtpPrompt: opts.onOtpPrompt,
      },
      {
        fields: opts.fields,
        mode: opts.mode,
        labels: opts.labels,
        hasCredentials: !!opts.login,
        loginEmail: opts.login?.email ?? '',
        hasOtp: false,
        listUrl: opts.listUrl,
      },
    )
    let storageState: string | null = null
    try {
      storageState = JSON.stringify(await context.storageState())
    } catch {
      storageState = null
    }
    return { ...result, storageState }
  } finally {
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
    browserOpen = false
  }
}
