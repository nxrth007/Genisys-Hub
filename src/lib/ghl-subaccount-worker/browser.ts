/**
 * Playwright side of one create. The decisions are in plan.ts; this
 * file only launches Chromium, keeps the session, and performs the
 * action the planner asked for. Tests never import it.
 */
import type { Browser, BrowserContext, Frame, Page } from 'playwright'
import { chromiumLaunchArgs, prepareChromiumEnv } from './chromium-host'
import type { BrowserFields } from './fields'
import type { GhlLabels } from './labels'
import { driveUntil, LIST_READY_PATTERN, LIST_RENDER_WAIT_MS, type BrowserAction, type DriveResult, type PageSnap } from './plan'
import { GHL_PAGE_SOURCE } from './page-source'

/** One Chromium at a time. A second launch would sit on top of the Hub's memory. */
let browserOpen = false

export type BrowserRunOptions = {
  fields: BrowserFields
  mode: 'dry_run' | 'create'
  labels: GhlLabels
  listUrl: string
  listUrlOverride?: string
  snapshotTab?: string
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

type CommandResult = { ok?: boolean; retry?: boolean; error?: string; href?: string; url?: string; fields?: unknown }

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

async function runCommand(frame: Frame, cmd: Record<string, unknown>): Promise<CommandResult> {
  const expr = `(${GHL_PAGE_SOURCE})(${JSON.stringify(cmd)})`
  return (await frame.evaluate(expr)) as CommandResult
}

async function snapshotPage(page: Page, labels: GhlLabels): Promise<PageSnap> {
  const merged: PageSnap = { url: page.url(), fields: [], buttons: [], texts: [], links: [], checks: [], tabs: [], cards: [], frames: [], body: '' }
  for (const frame of page.frames()) {
    try {
      const snap = (await runCommand(frame, { op: 'snapshot', labels })) as PageSnap
      if (!snap || !Array.isArray(snap.fields)) {
        merged.frames!.push({ url: frame.url(), buttons: [], fieldCount: 0 })
        continue
      }
      merged.frames!.push({ url: snap.url || frame.url(), buttons: snap.buttons || [], fieldCount: snap.fields.length })
      const seenButtons = new Set(merged.buttons)
      for (const button of snap.buttons || []) {
        if (!seenButtons.has(button)) {
          seenButtons.add(button)
          merged.buttons.push(button)
        }
      }
      merged.fields.push(...(snap.fields || []))
      merged.links.push(...(snap.links || []))
      for (const text of snap.texts || []) if (merged.texts.length < 200) merged.texts.push(text)
      merged.checks = [...(merged.checks || []), ...(snap.checks || [])]
      const seenTabs = new Set(merged.tabs || [])
      for (const tab of snap.tabs || []) {
        if (!seenTabs.has(tab)) {
          seenTabs.add(tab)
          merged.tabs!.push(tab)
        }
      }
      const seenCards = new Set(merged.cards || [])
      for (const card of snap.cards || []) {
        if (!seenCards.has(card)) {
          seenCards.add(card)
          merged.cards!.push(card)
        }
      }
      if ((snap.body || '').length > merged.body.length) merged.body = snap.body
    } catch {
      merged.frames!.push({ url: frame.url(), buttons: [], fieldCount: 0 })
    }
  }
  merged.url = page.url() || merged.url
  if (merged.frames!.length) return merged
  return { ...EMPTY_SNAP, url: page.url(), frames: [{ url: page.url(), buttons: [], fieldCount: 0 }] }
}

async function frameUrls(page: Page): Promise<string[]> {
  return page.frames().map((frame) => frame.url())
}

async function anyFrameMatches(page: Page, pattern: string): Promise<boolean> {
  for (const frame of page.frames()) {
    try {
      const hit = await Promise.race([
        frame.evaluate((source) => {
          const text = (document.body && document.body.innerText) || ''
          return new RegExp(source, 'i').test(text)
        }, pattern),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
      ])
      if (hit) return true
    } catch {
      // A frame can be navigating.
    }
  }
  return false
}

async function waitForListRender(page: Page, before: string[], signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + LIST_RENDER_WAIT_MS
  const previous = new Set(before)
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('The job ran out of time.')
    const now = await frameUrls(page)
    const changed = now.some((url) => url && url !== 'about:blank' && !previous.has(url))
    const ready = await anyFrameMatches(page, LIST_READY_PATTERN)
    if (changed && ready) return
    await sleep(400, signal)
  }
}

async function waitForDetailsForm(page: Page, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('The job ran out of time.')
    const ready = await anyFrameMatches(page, 'business name|account name|first name|email|phone')
    const modalGone = !(await anyFrameMatches(page, 'select snapshot template'))
    if (ready && modalGone) return
    await sleep(400, signal)
  }
}

async function selectSnapshotCard(page: Page, name: string, signal?: AbortSignal): Promise<boolean> {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const exact = new RegExp(`^\\s*${escaped}\\s*$`, 'i')
  const continueName = /select\s*(&|and)\s*continue/i
  for (const frame of page.frames()) {
    if (signal?.aborted) throw new Error('The job ran out of time.')
    const labels = frame.getByText(exact)
    const count = await labels.count().catch(() => 0)
    for (let i = 0; i < Math.min(count, 8); i++) {
      const label = labels.nth(i)
      if (!(await label.isVisible().catch(() => false))) continue
      await label.hover({ timeout: 4000 }).catch(() => {})
      const card = label.locator('xpath=ancestor-or-self::*[.//button or .//*[@role="button"]][1]')
      const onCard = card.getByRole('button', { name: continueName })
      const anywhere = frame.getByRole('button', { name: continueName })
      const target = (await onCard.count().catch(() => 0)) > 0 ? onCard.first() : anywhere.first()
      if ((await target.count().catch(() => 0)) === 0) continue
      await target.click({ timeout: 5000 })
      return true
    }
  }
  return false
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
): Promise<{ href?: string }> {
  if (action.type === 'pause') {
    await sleep(900, signal)
    return {}
  }
  if (action.type === 'goto') {
    const before = action.settle ? await frameUrls(page) : []
    await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    if (action.settle) await waitForListRender(page, before, signal)
    else await sleep(800, signal)
    return {}
  }
  if (action.type === 'select_card') {
    const picked = await selectSnapshotCard(page, action.name, signal)
    if (!picked) throw new Error(`Couldn't hover the "${action.name}" card and click Select & Continue.`)
    await waitForDetailsForm(page, signal)
    return {}
  }
  if (action.type === 'wait_otp' || action.type === 'press_enter') {
    if (action.type === 'press_enter') {
      await runAcrossFrames(page, { op: 'pressEnter', labels })
    }
    return {}
  }
  if (action.type === 'remember') {
    await runAcrossFrames(page, { op: 'remember', labels })
    await sleep(300, signal)
    return {}
  }
  if (action.type === 'fill_otp') {
    const cmd = { op: 'fillOtp', value: secrets.otp, labels }
    const res = await runAcrossFrames(page, cmd)
    if (!res?.ok) throw new Error(res?.error || 'No code box on the page')
    await sleep(400, signal)
    return {}
  }
  if (action.type === 'click_verify') {
    await runAcrossFrames(page, { op: 'clickVerify', words: action.words, labels })
    await sleep(900, signal)
    return {}
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
  const before = action.type === 'click' && action.settle ? await frameUrls(page) : []
  const cmd = {
    op: action.type,
    key: 'key' in action ? action.key : undefined,
    words: 'words' in action ? action.words : [],
    exact: 'exact' in action ? action.exact : false,
    contains: 'contains' in action ? action.contains : false,
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
          if (action.type === 'click' && action.settle) await waitForListRender(page, before, signal)
          else await sleep(action.type === 'click' ? 900 : 250, signal)
          return { href: res.href }
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
    let navHref = ''
    const result = await driveUntil(
      {
        snapshot: async () => {
          const snap = await snapshotPage(page, opts.labels)
          if (navHref) {
            snap.navHref = navHref
            navHref = ''
          }
          return snap
        },
        perform: async (action) => {
          const done = await performAction(page, action, opts.labels, secrets, opts.signal)
          if (done.href) navHref = done.href
        },
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
        listUrlOverride: opts.listUrlOverride,
        snapshotTab: opts.snapshotTab,
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
