/**
 * Playwright side of one create. The decisions are in plan.ts; this
 * file only launches Chromium, keeps the session, and performs the
 * action the planner asked for. Tests never import it.
 */
import type { Browser, BrowserContext, ElementHandle, Frame, Page } from 'playwright'
import { chromiumLaunchArgs, prepareChromiumEnv } from './chromium-host'
import type { BrowserFields } from './fields'
import type { GhlLabels } from './labels'
import { driveUntil, LIST_RENDER_WAIT_MS, bestSaveLabel, type BrowserAction, type DriveResult, type PageSnap } from './plan'
import { GHL_PAGE_SOURCE } from './page-source'
import { ADD_MANUALLY_ATTEMPTS, locateAddManually, locateSnapshotCard, redactCardHtml, runSearchAddManually } from './snapshot-card'

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
  /** JPEG of the current page. Dry-run steps and failures. */
  capture?: (step: string, image: Buffer) => Promise<void>
  onNote?: (line: string) => Promise<void>
  headless: boolean
  executablePath?: string
  signal?: AbortSignal
}

export type BrowserRunResult = DriveResult & { storageState: string | null }

type CommandResult = { ok?: boolean; retry?: boolean; error?: string; href?: string; url?: string; fields?: unknown; buttons?: string[] }

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
  const merged: PageSnap = { url: page.url(), fields: [], buttons: [], texts: [], links: [], checks: [], tabs: [], cards: [], overlays: [], frames: [], body: '' }
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
      const seenOverlays = new Set(merged.overlays || [])
      for (const overlay of snap.overlays || []) {
        if (!seenOverlays.has(overlay)) {
          seenOverlays.add(overlay)
          merged.overlays!.push(overlay)
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

async function subAccountListReady(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    try {
      const hit = await Promise.race([
        frame.evaluate(() => {
          const labelOf = (el: Element) => (el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()
          const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'))
          if (buttons.some((el) => /^\+?\s*create sub-?account$/i.test(labelOf(el)))) return true
          const body = (document.body && document.body.innerText) || ''
          if (/start creating sub-?accounts/i.test(body)) return false
          return /\d+\s+sub-?accounts?\b/i.test(body)
        }),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
      ])
      if (hit) return true
    } catch {
      // A frame can be navigating.
    }
  }
  return false
}

async function waitForListRender(page: Page, signal?: AbortSignal): Promise<void> {
  const started = Date.now()
  const deadline = started + LIST_RENDER_WAIT_MS
  let reloaded = false
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('The job ran out of time.')
    if (await subAccountListReady(page)) return
    if (!reloaded && Date.now() - started > 15_000) {
      reloaded = true
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {})
    }
    await sleep(500, signal)
  }
}

async function waitForSnapshotModal(page: Page, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('The job ran out of time.')
    if (await anyFrameMatches(page, 'select snapshot template')) return true
    await sleep(400, signal)
  }
  return false
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

const CONTINUE_RE = /select\s*&?\s*continue/i
const MODAL_ACTION_RE = /^\s*(continue|next|select)\s*$/i

async function clickVisible(frame: Frame, pattern: RegExp): Promise<boolean> {
  const loc = frame.locator('a, button, [role="button"]').filter({ hasText: pattern })
  const count = await loc.count().catch(() => 0)
  for (let i = 0; i < count; i++) {
    const item = loc.nth(i)
    if (!(await item.isVisible().catch(() => false))) continue
    await item.click({ timeout: 3000 })
    return true
  }
  return false
}

async function waitForContinue(frame: Frame, signal: AbortSignal | undefined, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('The job ran out of time.')
    if (await clickVisible(frame, CONTINUE_RE)) return true
    await sleep(200, signal)
  }
  return false
}

async function nudgeCard(page: Page, card: ElementHandle<Element>): Promise<void> {
  const box = await card.boundingBox().catch(() => null)
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2).catch(() => {})
  }
  await card
    .evaluate((node) => {
      const rect = node.getBoundingClientRect()
      const init = {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        view: window,
      }
      for (const type of ['pointerover', 'mouseover', 'mouseenter', 'pointerenter', 'mousemove']) {
        node.dispatchEvent(new MouseEvent(type, init))
      }
    })
    .catch(() => {})
}

async function cardFailure(card: ElementHandle<Element>): Promise<string> {
  const info = await card
    .evaluate((node) => {
      const rect = node.getBoundingClientRect()
      const dialog = node.closest('[role="dialog"], [aria-modal="true"]') || node.ownerDocument.body
      const buttons = Array.from(dialog.querySelectorAll('a, button, [role="button"]'))
        .map((el) => (el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 30)
      return {
        html: node.outerHTML || '',
        box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        buttons,
      }
    })
    .catch(() => ({ html: '', box: { x: 0, y: 0, w: 0, h: 0 }, buttons: [] as string[] }))
  const buttons = info.buttons.join(', ') || '(none)'
  return `card box: x=${info.box.x} y=${info.box.y} w=${info.box.w} h=${info.box.h}\nbuttons after hover: ${buttons}\ncard html: ${redactCardHtml(info.html)}`
}

async function selectSnapshotCard(page: Page, name: string, signal?: AbortSignal): Promise<void> {
  let failure = `No card whose title is exactly "${name}" was found.`
  for (const frame of page.frames()) {
    if (signal?.aborted) throw new Error('The job ran out of time.')
    const handle = await frame.evaluateHandle(locateSnapshotCard, name).catch(() => null)
    const card = handle && 'asElement' in handle ? handle.asElement() : null
    if (!card) {
      await handle?.dispose().catch(() => {})
      continue
    }
    try {
      await card.scrollIntoViewIfNeeded().catch(() => {})
      let hovered = false
      try {
        await card.hover({ timeout: 3000 })
        hovered = true
      } catch {
        await nudgeCard(page, card)
      }
      if (await waitForContinue(frame, signal, 5000)) return
      if (hovered) {
        await nudgeCard(page, card)
        if (await waitForContinue(frame, signal, 5000)) return
      }
      await card.click({ timeout: 3000 }).catch(() => {})
      if (await waitForContinue(frame, signal, 1500)) return
      if (await clickVisible(frame, MODAL_ACTION_RE)) return
      if (await anyFrameMatches(page, 'business name|account name|first name')) return
      failure = await cardFailure(card)
    } finally {
      await card.dispose().catch(() => {})
    }
  }
  throw new Error(`Couldn't hover the "${name}" card and click Select & Continue.\n${failure}`)
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

async function findAddManually(page: Page): Promise<ElementHandle<Element> | null> {
  for (const frame of page.frames()) {
    const handle = await frame.evaluateHandle(locateAddManually).catch(() => null)
    const el = handle && 'asElement' in handle ? handle.asElement() : null
    if (el) return el
    await handle?.dispose().catch(() => {})
  }
  return null
}

async function manualStepOpened(page: Page, beforeUrl: string, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('The job ran out of time.')
    if (page.url() !== beforeUrl) return true
    for (const frame of page.frames()) {
      try {
        const hit = await frame.evaluate(() => {
          const shown = (el: Element) => {
            const rect = el.getBoundingClientRect()
            const style = getComputedStyle(el)
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
          }
          const labelOf = (el: Element) => {
            let label = ''
            if ((el as HTMLInputElement).id) {
              const lab = document.querySelector('label[for="' + CSS.escape((el as HTMLInputElement).id) + '"]')
              if (lab) label = lab.textContent || ''
            }
            const wrap = el.closest ? el.closest('label') : null
            if (!label && wrap) label = wrap.textContent || ''
            return `${label} ${el.getAttribute('aria-label') || ''} ${(el as HTMLInputElement).placeholder || ''}`
          }
          const inputs = Array.from(document.querySelectorAll('input, textarea, select'))
          if (inputs.some((el) => shown(el) && /business name|company|first name|email|phone|address/i.test(labelOf(el)))) return true
          const overlays = Array.from(document.querySelectorAll('[role=dialog], .modal, [class*=drawer], [class*=Drawer]'))
          return overlays.some((el) => shown(el))
        })
        if (hit) return true
      } catch {
        // This frame is navigating.
      }
    }
    await sleep(300, signal)
  }
  return false
}

async function openAddManually(
  page: Page,
  signal: AbortSignal | undefined,
  adopt: (page: Page) => void,
  log: (line: string) => Promise<void>,
  capture: (step: string) => Promise<void>,
): Promise<string> {
  const beforeUrl = page.url()
  const el = await findAddManually(page)
  if (!el) {
    await log('Add manually try failed: no element whose own text is “add manually”')
    await capture('failure:add-manually')
    throw new Error('Could not find “Add manually” on the business search page.')
  }
  let popup: Page | null = null
  const onPage = (next: Page) => {
    popup = next
  }
  page.context().on('page', onPage)
  const opened = async () => {
    if (signal?.aborted) throw new Error('The job ran out of time.')
    if (popup) {
      adopt(popup)
      await popup.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {})
      return true
    }
    return manualStepOpened(page, beforeUrl, signal)
  }
  try {
    await el.scrollIntoViewIfNeeded().catch(() => {})
    const ancestor = await el.evaluateHandle((node) => node.closest('a, button, [role="button"], [class*="cursor-pointer"]'))
    const anc = ancestor.asElement()
    return await runSearchAddManually({
      log,
      capture,
      opened,
      attempts: [
        { name: ADD_MANUALLY_ATTEMPTS[0], run: () => el.click({ timeout: 3000 }) },
        { name: ADD_MANUALLY_ATTEMPTS[1], run: async () => { if (anc) await anc.click({ timeout: 3000 }) } },
        {
          name: ADD_MANUALLY_ATTEMPTS[2],
          run: async () => {
            const box = await el.boundingBox()
            if (!box) throw new Error('Add manually has no bounding box')
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
          },
        },
      ],
    })
  } finally {
    page.context().off('page', onPage)
    await el.dispose().catch(() => {})
  }
}

async function scrollDetailsForm(page: Page): Promise<string[]> {
  const found: string[] = []
  for (const frame of page.frames()) {
    try {
      const res = await runCommand(frame, { op: 'scrollForm' })
      for (const button of res?.buttons || []) {
        if (button && !found.includes(button)) found.push(button)
      }
    } catch {
      // A frame can be navigating.
    }
  }
  return found
}

async function capturePage(page: Page): Promise<Buffer> {
  const previous = page.viewportSize()
  if (!previous || previous.width > 1280) await page.setViewportSize({ width: 1280, height: previous?.height || 900 }).catch(() => {})
  try {
    return await page.screenshot({ fullPage: true, type: 'jpeg', quality: 60, animations: 'disabled' })
  } finally {
    if (previous && previous.width > 1280) await page.setViewportSize(previous).catch(() => {})
  }
}

async function performAction(
  page: Page,
  action: BrowserAction,
  labels: GhlLabels,
  secrets: { password: string; otp: string },
  signal: AbortSignal | undefined,
  adopt: (page: Page) => void,
  log: (line: string) => Promise<void>,
  capture: (step: string) => Promise<void>,
): Promise<{ href?: string; note?: string }> {
  if (action.type === 'pause') {
    await sleep(900, signal)
    return {}
  }
  if (action.type === 'wait_list') {
    await waitForListRender(page, signal)
    return {}
  }
  if (action.type === 'goto') {
    await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    if (action.settle) await waitForListRender(page, signal)
    else await sleep(800, signal)
    return {}
  }
  if (action.type === 'select_card') {
    await selectSnapshotCard(page, action.name, signal)
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

  if (action.type === 'add_manually') {
    await openAddManually(page, signal, adopt, log, capture)
    await waitForDetailsForm(page, signal)
    return {}
  }

  if (action.type === 'scroll_form') {
    const found = await scrollDetailsForm(page)
    await capture('details form bottom')
    return { note: `Save button: ${bestSaveLabel(found)}` }
  }

  if (action.type === 'record_form') {
    await capture('details form filled')
    return {}
  }

  if (action.type === 'click' && action.words.some((word) => /add manually/i.test(word))) {
    await openAddManually(page, signal, adopt, log, capture)
    if (action.settle === 'form') await waitForDetailsForm(page, signal)
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
          if (action.type === 'click' && action.settle === 'modal') {
            if (!(await waitForSnapshotModal(page, signal))) {
              for (const frame of page.frames()) {
                try {
                  const again = await runCommand(frame, cmd)
                  if (again?.ok) break
                } catch {
                  // The next frame may hold the button.
                }
              }
              await waitForSnapshotModal(page, signal)
            }
          } else if (action.type === 'click' && action.settle === 'form') {
            await waitForDetailsForm(page, signal)
          } else if (action.type === 'click' && action.settle) {
            await waitForListRender(page, signal)
          } else {
            await sleep(action.type === 'click' ? 900 : 250, signal)
          }
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
    let active = page
    const shoot = async (step: string) => {
      try {
        const image = await capturePage(active)
        if (!opts.capture) {
          await opts.onNote?.(`Screenshot save failed at step ${step}: no screenshot store is configured`)
          return
        }
        await opts.capture(step, image)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await opts.onNote?.(`Screenshot save failed at step ${step}: ${message}`)
      }
    }
    let result: Awaited<ReturnType<typeof driveUntil>>
    try {
      result = await driveUntil(
      {
        snapshot: async () => {
          const snap = await snapshotPage(active, opts.labels)
          if (navHref) {
            snap.navHref = navHref
            navHref = ''
          }
          return snap
        },
        perform: async (action) => {
          const done = await performAction(
            active,
            action,
            opts.labels,
            secrets,
            opts.signal,
            (next) => {
              active = next
            },
            async (line) => {
              await opts.onNote?.(line)
            },
            shoot,
          )
          if (done.href) navHref = done.href
          if (done.note) await opts.onNote?.(done.note)
          if (opts.mode !== 'create' && (action.type === 'fill' || action.type === 'pick') && action.key !== 'password') {
            await opts.onNote?.(`Set ${action.key} = ${action.value ?? ''}`)
          }
          if (opts.mode !== 'create') {
            const step =
              action.type === 'click'
                ? `click ${action.words.slice(0, 3).join(' / ')}`
                : action.type === 'goto'
                  ? `goto ${action.url}`
                  : action.type === 'select_card'
                    ? `select ${action.name}`
                    : action.type === 'add_manually'
                  ? 'add manually'
                  : action.type === 'wait_list'
                      ? 'wait for list'
                      : ''
            if (step) await shoot(step.slice(0, 160))
          }
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
    } catch (err) {
      await shoot('failure:exception')
      throw err
    }
    if (result.status === 'needs_human' || result.status === 'failed') {
      await shoot(`failure:${result.status}`)
    }
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
