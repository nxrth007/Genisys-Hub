/**
 * Playwright side of one create. The decisions are in plan.ts; this
 * file only launches Chromium, keeps the session, and performs the
 * action the planner asked for. Tests never import it.
 */
import type { Browser, BrowserContext, ElementHandle, Frame, Page } from 'playwright'
import { chromiumLaunchArgs, prepareChromiumEnv } from './chromium-host'
import { loadSnapshotButton, snapshotSettingsUrls, type BrowserFields } from './fields'
import {
  agencyPushUrlAllowed,
  agencySnapshotUrls,
  countsFromAssetPayload,
  describeAssetCounts,
  emptyAssetCounts,
  freshSnapshotLoad,
  locationAssetPages,
  nextSnapshotLoadAction,
  snapshotLoadUrlAllowed,
  visibleControls,
  type AssetCounts,
  type SnapshotLoadProgress,
} from './snapshot-load'
import {
  chooseLocationTarget,
  chooseSnapshotMenuAction,
  confirmPushControl,
  isUnsafeSnapshotControl,
  mergeSnapshotRows,
  overwriteControl,
  readSnapshotCatalog,
  type SnapshotRow,
} from './snapshot-catalog'
import type { GhlLabels } from './labels'
import { driveUntil, LIST_RENDER_WAIT_MS, bestSaveLabel, snapshotIdFromUrl, type BrowserAction, type DriveResult, type PageSnap } from './plan'
import { GHL_PAGE_SOURCE } from './page-source'
import {
  ADD_MANUALLY_ATTEMPTS,
  dialogChoiceLabels,
  listSnapshotCardRefs,
  locateAddManually,
  locateRowMenu,
  locateSnapshotCard,
  locateSnapshotCardById,
  matchingSnapshotRows,
  redactCardHtml,
  runSearchAddManually,
  visibleControlLabels,
} from './snapshot-card'

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

type CommandResult = { ok?: boolean; retry?: boolean; error?: string; href?: string; url?: string; fields?: unknown; buttons?: string[]; selected?: string }

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
      const refs = (await frame.evaluate(listSnapshotCardRefs as () => { name: string; id: string }[]).catch(() => [])) as { name: string; id: string }[]
      const seenRefs = new Set((merged.cardRefs || []).map((ref) => ref.id))
      for (const ref of refs) {
        if (!ref?.id || seenRefs.has(ref.id)) continue
        seenRefs.add(ref.id)
        merged.cardRefs = [...(merged.cardRefs || []), ref]
      }
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

async function readSelectedSnapshotName(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const root = document.querySelector('[role="dialog"], [aria-modal="true"]') || document.body
      const selected = root.querySelector('[aria-selected="true"]')
      const text = ((selected && selected.textContent) || '').replace(/\s+/g, ' ').trim()
      return text.length > 1 && text.length < 80 ? text : ''
    })
    .catch(() => '')
}

async function selectSnapshotCard(page: Page, name: string, signal?: AbortSignal, snapshotId?: string): Promise<{ id: string | null; name: string }> {
  let failure = `No card whose title is exactly "${name}" was found.`
  for (const frame of page.frames()) {
    if (signal?.aborted) throw new Error('The job ran out of time.')
    const byId = snapshotId ? await frame.evaluateHandle(locateSnapshotCardById, { name, id: snapshotId }).catch(() => null) : null
    const byIdCard = byId && 'asElement' in byId ? byId.asElement() : null
    const handle = byIdCard ? byId : await frame.evaluateHandle(locateSnapshotCard, name).catch(() => null)
    if (!byIdCard) await byId?.dispose().catch(() => {})
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
      const selected = async () => {
        const id = snapshotIdFromUrl(page.url())
        const readName = (await readSelectedSnapshotName(page)) || name
        if (snapshotId && id && id !== snapshotId) {
          throw new Error(`Selected snapshot read back from the page: id=${id} name="${readName}". Wanted ${snapshotId}. Nothing was created.`)
        }
        return { id, name: readName }
      }
      if (await waitForContinue(frame, signal, 5000)) return selected()
      if (hovered) {
        await nudgeCard(page, card)
        if (await waitForContinue(frame, signal, 5000)) return selected()
      }
      await card.click({ timeout: 3000 }).catch(() => {})
      if (await waitForContinue(frame, signal, 1500)) return selected()
      if (await clickVisible(frame, MODAL_ACTION_RE)) return selected()
      if (await anyFrameMatches(page, 'business name|account name|first name')) return selected()
      failure = await cardFailure(card)
    } finally {
      await card.dispose().catch(() => {})
    }
  }
  const labels = await page.evaluate(visibleControlLabels as () => string[]).catch(() => [] as string[])
  throw new Error(`Couldn't hover the "${name}" card and click Select & Continue. Visible controls: ${visibleControls(labels)}.\n${failure}`)
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
  if (action.type === 'note') return { note: action.text }
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
    const selected = await selectSnapshotCard(page, action.name, signal, action.id)
    await log(`Selected snapshot read back from the modal: id=${selected.id || '(not in the url)'} name="${selected.name}".`)
    if (action.id && selected.id && selected.id !== action.id) {
      throw new Error(`Selected snapshot read back from the modal: id=${selected.id} name="${selected.name}". Wanted ${action.id}. Nothing was created.`)
    }
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
          const selected = typeof res.selected === 'string' ? res.selected.trim() : ''
          if (action.type === 'pick' && (action.key === 'country' || action.key === 'timezone' || action.key === 'state')) {
            const wanted = action.value
            const reads = selected || '(empty)'
            return { href: res.href, note: `Set ${action.key} = ${wanted}; control reads "${reads}".` }
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
          const beforeSnapshot = action.type === 'add_manually' ? snapshotIdFromUrl(active.url()) : null
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
          else if (opts.mode !== 'create' && (action.type === 'fill' || action.type === 'pick') && action.key !== 'password') {
            await opts.onNote?.(`Set ${action.key} = ${action.value ?? ''}`)
          }
          if (action.type === 'add_manually') {
            const afterSnapshot = snapshotIdFromUrl(active.url())
            const before = beforeSnapshot || '(none)'
            const after = afterSnapshot || '(none)'
            await opts.onNote?.(
              beforeSnapshot && beforeSnapshot !== afterSnapshot
                ? `Add manually dropped the snapshot query. Before: ${before}. After: ${after}.`
                : `Snapshot query before Add manually: ${before}. After: ${after}.`,
            )
          }
          if (
            opts.mode === 'create' &&
            action.type === 'click' &&
            action.words.some((word) => /add sub-?account|^save( changes)?$|^create$/i.test(word))
          ) {
            const snapshot = opts.fields.snapshotName || opts.fields.snapshotId
            await opts.onNote?.(`Submitting "${action.words[0]}" with snapshot "${snapshot}".`)
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
    if ((result.status === 'created' || result.status === 'already') && result.locationId && opts.mode === 'create') {
      const url = `https://app.gohighlevel.com/v2/location/${result.locationId}/dashboard`
      try {
        await active.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
        await sleep(1500, opts.signal)
        const seen = await snapshotPage(active, opts.labels)
        const blob = `${seen.body || ''}\n${(seen.overlays || []).join('\n')}`
        const importing = /import|loading snapshot|snapshot is being|installing snapshot/i.test(blob)
        await opts.onNote?.(
          `Opened the new location ${url}. ${importing ? 'The page mentions a snapshot import.' : 'The page did not mention a snapshot import.'} Text: ${blob.replace(/\s+/g, ' ').slice(0, 300)}`,
        )
        await shoot('location after create')
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await opts.onNote?.(`Could not open the new location to check the snapshot: ${message}`)
      }
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

export type SnapshotInspectResult = { note: string; image: Buffer | null; pushed: boolean }

/**
 * Open a location's snapshot settings page and screenshot it.
 * `push` may press only Load snapshot / Push snapshot / Push to sub-account.
 * It never presses Create or Add Sub-Account.
 */
export async function inspectLocationSnapshot(opts: {
  locationId: string
  origin: string
  push: boolean
  labels: GhlLabels
  storageState: string | null
  headless: boolean
  executablePath?: string
}): Promise<SnapshotInspectResult> {
  if (browserOpen) {
    return { note: 'Screenshot skipped: a browser is already open.', image: null, pushed: false }
  }
  browserOpen = true
  prepareChromiumEnv()
  const pw = (await import('playwright')) as typeof import('playwright')
  let browser: Browser | null = null
  let context: BrowserContext | null = null
  try {
    browser = await pw.chromium.launch({
      headless: opts.headless,
      executablePath: opts.executablePath || undefined,
      args: chromiumLaunchArgs(),
    })
    context = await browser.newContext({
      storageState: parseStorage(opts.storageState) as Awaited<ReturnType<BrowserContext['storageState']>> | undefined,
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(20_000)
    const urls = snapshotSettingsUrls(opts.origin, opts.locationId)
    let opened = urls[0]
    let snap: PageSnap | null = null
    for (const url of urls) {
      opened = url
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      await page.waitForTimeout(1500)
      snap = await snapshotPage(page, opts.labels)
      const text = `${snap.body || ''}\n${(snap.buttons || []).join('\n')}`
      if (/snapshot/i.test(text) || /sign in|log in|password/i.test(text)) break
    }
    if (!snap) throw new Error('No snapshot settings page was opened.')
    const buttons = snap.buttons || []
    const signedOut = /sign in|log in|password/i.test(snap.body || '')
    let image: Buffer | null = null
    try {
      image = await capturePage(page)
    } catch {
      image = null
    }
    if (signedOut) {
      return {
        note: `Opened ${opened}. The page is signed out, so nothing was clicked. Buttons: ${buttons.slice(0, 12).join(', ') || '(none)'}.`,
        image,
        pushed: false,
      }
    }
    const load = opts.push ? loadSnapshotButton(buttons) : null
    if (!opts.push || !load) {
      const held = opts.push ? 'Load snapshot was not on the page, so nothing was clicked.' : 'Nothing was clicked.'
      return {
        note: `Opened ${opened}. ${held} Buttons: ${buttons.slice(0, 12).join(', ') || '(none)'}.`,
        image,
        pushed: false,
      }
    }
    let clicked = false
    for (const frame of page.frames()) {
      try {
        const res = await runCommand(frame, { op: 'click', words: [load], exact: true, labels: opts.labels })
        if (res?.ok) {
          clicked = true
          break
        }
      } catch {
        // Another frame may hold the button.
      }
    }
    await page.waitForTimeout(1500)
    try {
      image = await capturePage(page)
    } catch {
      // Keep the first shot.
    }
    return {
      note: clicked
        ? `Opened ${opened} and pressed "${load}". No other button was pressed.`
        : `Opened ${opened}. "${load}" was visible but the click did not land. Nothing else was pressed.`,
      image,
      pushed: clicked,
    }
  } finally {
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
    browserOpen = false
  }
}

async function openWorkerBrowser(opts: { storageState: string | null; headless: boolean; executablePath?: string }): Promise<{ browser: Browser; context: BrowserContext; page: Page } | null> {
  if (browserOpen) return null
  browserOpen = true
  try {
    prepareChromiumEnv()
    const pw = (await import('playwright')) as typeof import('playwright')
    const browser = await pw.chromium.launch({
      headless: opts.headless,
      executablePath: opts.executablePath || undefined,
      args: chromiumLaunchArgs(),
    })
    const context = await browser.newContext({
      storageState: parseStorage(opts.storageState) as Awaited<ReturnType<BrowserContext['storageState']>> | undefined,
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(20_000)
    return { browser, context, page }
  } catch (err) {
    browserOpen = false
    throw err
  }
}

async function loadPageView(page: Page, labels: GhlLabels): Promise<{ url: string; body: string; labels: string[] }> {
  const snap = await snapshotPage(page, labels)
  const extra = await page.evaluate(() => {
    const out: string[] = []
    document.querySelectorAll('label, [role="checkbox"], [role="radio"]').forEach((el) => {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
      if (text && text.length < 120) out.push(text)
    })
    return out
  }).catch(() => [] as string[])
  return { url: page.url(), body: snap.body || '', labels: [...(snap.buttons || []), ...extra] }
}

async function clickLabel(page: Page, labels: GhlLabels, label: string, contains: boolean): Promise<boolean> {
  for (const frame of page.frames()) {
    try {
      const res = await runCommand(frame, { op: 'click', words: [label], exact: !contains, contains, labels })
      if (res?.ok) return true
    } catch {
      // Another frame may hold the control.
    }
  }
  return false
}

export type SnapshotLoadBrowserResult = {
  busy: boolean
  clicked: boolean
  notes: string[]
  before: Buffer | null
  after: Buffer | null
}

/**
 * Open one location's snapshot settings and load Master Template.
 * GHL does not put this control on the location page; the one-shot uses
 * the agency Account Snapshots push instead. Kept for the location page.
 * It never opens the create-sub-account flow.
 */
export async function loadSnapshotOnLocation(opts: {
  locationId: string
  origin: string
  snapshotName: string
  snapshotId: string
  labels: GhlLabels
  storageState: string | null
  headless: boolean
  executablePath?: string
}): Promise<SnapshotLoadBrowserResult> {
  const opened = await openWorkerBrowser(opts)
  if (!opened) return { busy: true, clicked: false, notes: ['Snapshot load skipped: a browser is already open.'], before: null, after: null }
  const { browser, context, page } = opened
  const notes: string[] = []
  let before: Buffer | null = null
  let after: Buffer | null = null
  let progress: SnapshotLoadProgress = freshSnapshotLoad()
  try {
    let view = { url: '', body: '', labels: [] as string[] }
    for (const url of snapshotSettingsUrls(opts.origin, opts.locationId)) {
      if (!snapshotLoadUrlAllowed(url, opts.locationId)) continue
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      await page.waitForTimeout(1500)
      view = await loadPageView(page, opts.labels)
      if (/snapshot/i.test(`${view.body}\n${view.labels.join('\n')}`) || /sign in|log in/i.test(view.body)) break
    }
    if (!snapshotLoadUrlAllowed(page.url(), opts.locationId)) {
      return { busy: false, clicked: false, notes: [`Refusing to continue. Landed on ${page.url()}, which is not location ${opts.locationId}.`], before, after }
    }
    try {
      before = await capturePage(page)
    } catch {
      before = null
    }
    let stalls = 0
    for (let step = 0; step < 8; step++) {
      const decision = nextSnapshotLoadAction({
        url: page.url(),
        locationId: opts.locationId,
        labels: view.labels,
        body: view.body,
        snapshotName: opts.snapshotName,
        snapshotId: opts.snapshotId,
        progress,
      })
      if (decision.type === 'stop') {
        if (!decision.ok && stalls < 3) {
          stalls += 1
          await page.waitForTimeout(1000)
          view = await loadPageView(page, opts.labels)
          continue
        }
        notes.push(decision.reason)
        break
      }
      if (!snapshotLoadUrlAllowed(page.url(), opts.locationId)) {
        notes.push(`Stopped before clicking "${decision.click.label}". The page left location ${opts.locationId}.`)
        break
      }
      const landed = await clickLabel(page, opts.labels, decision.click.label, decision.click.contains)
      if (!landed) {
        notes.push(`Could not press "${decision.click.label}".`)
        break
      }
      notes.push(`Pressed "${decision.click.label}".`)
      progress = decision.click.progress
      stalls = 0
      await page.waitForTimeout(1200)
      view = await loadPageView(page, opts.labels)
    }
    try {
      after = await capturePage(page)
    } catch {
      after = null
    }
    return { busy: false, clicked: progress.confirmed, notes, before, after }
  } finally {
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
    browserOpen = false
  }
}

/** Count pipelines, workflows, and funnels in one location. Does not click create or load. */
export async function countLocationAssets(opts: {
  locationId: string
  origin: string
  labels: GhlLabels
  storageState: string | null
  headless: boolean
  executablePath?: string
}): Promise<{ counts: AssetCounts; notes: string[]; busy: boolean }> {
  const counts: AssetCounts = emptyAssetCounts()
  const opened = await openWorkerBrowser(opts)
  if (!opened) return { counts, notes: ['Record count skipped: a browser is already open.'], busy: true }
  const { browser, context, page } = opened
  const notes: string[] = []
  const take = (part: Partial<AssetCounts> | null) => {
    if (!part) return
    if (typeof part.pipelines === 'number') counts.pipelines = part.pipelines
    if (typeof part.workflows === 'number') counts.workflows = part.workflows
    if (typeof part.funnels === 'number') counts.funnels = part.funnels
    if (typeof part.customFields === 'number') counts.customFields = part.customFields
    if (typeof part.tags === 'number') counts.tags = part.tags
  }
  page.on('response', (res) => {
    const url = res.url()
    if (!url.includes(opts.locationId)) return
    const type = res.headers()['content-type'] || ''
    if (!type.includes('json')) return
    void res.json().then((body) => take(countsFromAssetPayload(url, body, opts.locationId))).catch(() => {})
  })
  try {
    for (const asset of locationAssetPages(opts.origin, opts.locationId)) {
      if (!snapshotLoadUrlAllowed(asset.url, opts.locationId)) continue
      await page.goto(asset.url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      await page.waitForTimeout(2500)
      notes.push(`Opened ${asset.kind} at ${page.url()}.`)
    }
    const fetched = await page.evaluate(async (locationId) => {
      const tokenOf = () => {
        const direct = ['token', 'id_token', 'access_token', 'authToken']
        for (let i = 0; i < direct.length; i++) {
          const raw = localStorage.getItem(direct[i])
          if (raw && raw.length > 20) return raw.replace(/^"|"$/g, '')
        }
        for (let i = 0; i < localStorage.length; i++) {
          const raw = localStorage.getItem(localStorage.key(i) || '')
          if (!raw) continue
          if (raw.indexOf('eyJ') === 0) return raw
          try {
            const parsed = JSON.parse(raw) as { token?: unknown }
            if (parsed && typeof parsed.token === 'string' && parsed.token.length > 20) return parsed.token
          } catch {
            // Not a JSON token.
          }
        }
        return ''
      }
      const token = tokenOf()
      const hosts = ['https://services.leadconnectorhq.com', 'https://backend.leadconnectorhq.com']
      const paths = [
        { kind: 'pipelines', path: `/opportunities/pipelines?locationId=${locationId}` },
        { kind: 'workflows', path: `/workflows/?locationId=${locationId}` },
        { kind: 'funnels', path: `/funnels/funnel/list?locationId=${locationId}&limit=50&offset=0` },
        { kind: 'customFields', path: `/locations/${locationId}/customFields` },
        { kind: 'tags', path: `/locations/${locationId}/tags` },
      ]
      const out: { kind: string; url: string; body: unknown }[] = []
      for (let h = 0; h < hosts.length; h++) {
        for (let p = 0; p < paths.length; p++) {
          const url = hosts[h] + paths[p].path
          try {
            const res = await fetch(url, {
              headers: token ? { Authorization: `Bearer ${token}`, Version: '2021-07-28' } : { Version: '2021-07-28' },
            })
            if (!res.ok) continue
            out.push({ kind: paths[p].kind, url, body: await res.json() })
          } catch {
            // The next host may accept the session.
          }
        }
      }
      return out
    }, opts.locationId).catch(() => [] as { kind: string; url: string; body: unknown }[])
    for (const row of fetched) take(countsFromAssetPayload(row.url, row.body, opts.locationId))
    return { counts, notes, busy: false }
  } finally {
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
    browserOpen = false
  }
}

const SNAPSHOT_TABS = ['Imported Snapshots', 'My Snapshots']

function watchSnapshotResponses(page: Page, bucket: { url: string; body: unknown }[]): void {
  page.on('response', (res) => {
    const url = res.url()
    if (!/snapshot/i.test(url) || /snapshot-status/i.test(url)) return
    const type = res.headers()['content-type'] || ''
    if (!type.includes('json')) return
    void res.json().then((body) => bucket.push({ url, body })).catch(() => {})
  })
}

async function fetchSnapshotBodies(page: Page, ids: string[]): Promise<{ url: string; body: unknown }[]> {
  return page
    .evaluate(async (detailIds) => {
      const tokenOf = () => {
        const direct = ['token', 'id_token', 'access_token', 'authToken']
        for (let i = 0; i < direct.length; i++) {
          const raw = localStorage.getItem(direct[i])
          if (raw && raw.length > 20) return raw.replace(/^"|"$/g, '')
        }
        for (let i = 0; i < localStorage.length; i++) {
          const raw = localStorage.getItem(localStorage.key(i) || '')
          if (!raw) continue
          if (raw.indexOf('eyJ') === 0) return raw
          try {
            const parsed = JSON.parse(raw) as { token?: unknown }
            if (parsed && typeof parsed.token === 'string' && parsed.token.length > 20) return parsed.token
          } catch {
            // Not a JSON token.
          }
        }
        return ''
      }
      const companyOf = (token: string) => {
        try {
          const mid = token.split('.')[1]
          if (!mid) return ''
          const padded = mid.replace(/-/g, '+').replace(/_/g, '/')
          const json = JSON.parse(atob(padded)) as { companyId?: unknown; company_id?: unknown }
          if (typeof json.companyId === 'string') return json.companyId
          if (typeof json.company_id === 'string') return json.company_id
        } catch {
          // The session token is not a JWT. The list URL without a company id may still work.
        }
        return ''
      }
      const token = tokenOf()
      const companyId = companyOf(token)
      const q = companyId ? `?companyId=${encodeURIComponent(companyId)}` : ''
      const hosts = ['https://services.leadconnectorhq.com', 'https://backend.leadconnectorhq.com']
      const paths = [`/snapshots/${q}`, `/snapshots/list${q}`, `/snapshots/v2/list${q}`]
      for (let i = 0; i < detailIds.length && i < 40; i++) {
        paths.push(`/snapshots/${encodeURIComponent(detailIds[i])}${q}`)
      }
      const headers: Record<string, string> = { Accept: 'application/json', Version: '2021-07-28' }
      if (token) headers.Authorization = `Bearer ${token}`
      const out: { url: string; body: unknown }[] = []
      for (let h = 0; h < hosts.length; h++) {
        for (let p = 0; p < paths.length; p++) {
          const url = hosts[h] + paths[p]
          try {
            const res = await fetch(url, { headers })
            if (!res.ok) continue
            out.push({ url, body: await res.json() })
          } catch {
            // The next host may accept the session.
          }
        }
      }
      return out
    }, ids)
    .catch(() => [] as { url: string; body: unknown }[])
}

function catalogFrom(bucket: { url: string; body: unknown }[]): SnapshotRow[] {
  return mergeSnapshotRows(bucket.flatMap((item) => readSnapshotCatalog(item.body, item.url.replace(/^https?:\/\/[^/]+/, ''))))
}

async function pageLabels(page: Page): Promise<string[]> {
  return page.evaluate(visibleControlLabels as () => string[]).catch(() => [] as string[])
}

async function clickSafe(page: Page, labels: GhlLabels, label: string, contains: boolean, notes: string[]): Promise<boolean> {
  if (isUnsafeSnapshotControl(label)) {
    notes.push(`Refusing to click "${label}".`)
    return false
  }
  const landed = await clickLabel(page, labels, label, contains)
  if (!landed) {
    const seen = await pageLabels(page)
    notes.push(`Could not press "${label}". Visible controls: ${visibleControls(seen)}.`)
  }
  return landed
}

async function openAgencySnapshotPage(page: Page, origin: string, labels: GhlLabels, notes: string[]): Promise<boolean> {
  for (const url of agencySnapshotUrls(origin)) {
    if (!agencyPushUrlAllowed(url)) continue
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch((err) => {
      notes.push(`Could not open ${url}: ${err instanceof Error ? err.message : String(err)}`)
    })
    await page.waitForTimeout(1500)
    if (!agencyPushUrlAllowed(page.url())) {
      notes.push(`Refusing to continue. Landed on ${page.url()}, which is not an agency snapshot page.`)
      return false
    }
    const view = await loadPageView(page, labels)
    const signedOut = /sign in|log in|password/i.test(view.body) && !/snapshot/i.test(view.body)
    if (signedOut) {
      notes.push(`The snapshot page is signed out. Visible controls: ${visibleControls(view.labels)}. Nothing was clicked.`)
      return false
    }
    if (/snapshot/i.test(`${view.body}\n${view.labels.join('\n')}`)) return true
  }
  const view = await loadPageView(page, labels)
  const nav = view.labels.find((label) => /account snapshots/i.test(label) && !isUnsafeSnapshotControl(label))
  if (!nav) {
    notes.push(`Account Snapshots was not opened. Visible controls: ${visibleControls(view.labels)}.`)
    return false
  }
  const opened = await clickSafe(page, labels, nav, false, notes)
  if (!opened) return false
  await page.waitForTimeout(1500)
  if (!agencyPushUrlAllowed(page.url())) {
    notes.push(`Account Snapshots opened ${page.url()}. Nothing else was clicked.`)
    return false
  }
  return true
}

async function clickSnapshotTabs(page: Page, labels: GhlLabels, notes: string[]): Promise<void> {
  for (const tab of SNAPSHOT_TABS) {
    const seen = await pageLabels(page)
    const visible = seen.find((label) => label.toLowerCase().startsWith(tab.toLowerCase()))
    if (!visible) {
      notes.push(`Tab "${tab}" was not on the page. Visible controls: ${visibleControls(seen)}.`)
      continue
    }
    const landed = await clickSafe(page, labels, visible, false, notes)
    if (landed) notes.push(`Opened tab "${visible}".`)
    await page.waitForTimeout(1200)
  }
}

export type SnapshotListResult = {
  busy: boolean
  rows: SnapshotRow[]
  notes: string[]
  shots: { step: string; image: Buffer }[]
}

/**
 * Read My Snapshots and Imported Snapshots from the page's own JSON.
 * Clicks those tabs only. Does not open a menu, push, create, or delete.
 */
export async function listAgencySnapshots(opts: {
  origin: string
  labels: GhlLabels
  storageState: string | null
  headless: boolean
  executablePath?: string
}): Promise<SnapshotListResult> {
  const notes: string[] = []
  const shots: { step: string; image: Buffer }[] = []
  const opened = await openWorkerBrowser(opts)
  if (!opened) return { busy: true, rows: [], notes: ['Snapshot diagnostic skipped: a browser is already open.'], shots }
  const { browser, context, page } = opened
  const bucket: { url: string; body: unknown }[] = []
  watchSnapshotResponses(page, bucket)
  try {
    const onPage = await openAgencySnapshotPage(page, opts.origin, opts.labels, notes)
    if (onPage) {
      try {
        shots.push({ step: 'snapshot diagnostic', image: await capturePage(page) })
      } catch {
        // A shot is optional.
      }
      await clickSnapshotTabs(page, opts.labels, notes)
      await page.waitForTimeout(1000)
      try {
        shots.push({ step: 'snapshot diagnostic tabs', image: await capturePage(page) })
      } catch {
        // A shot is optional.
      }
    }
    const listed = catalogFrom(bucket)
    const fetched = await fetchSnapshotBodies(page, listed.map((row) => row.id))
    bucket.push(...fetched)
    const rows = catalogFrom(bucket)
    notes.push(rows.length ? `Read ${rows.length} snapshots from the page JSON.` : 'The page JSON had no snapshot id and name.')
    return { busy: false, rows, notes, shots }
  } finally {
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
    browserOpen = false
  }
}

async function rowCount(page: Page, target: { name: string; id: string }): Promise<number> {
  let count = 0
  for (const frame of page.frames()) {
    const handle = await frame.evaluateHandle(matchingSnapshotRows, target).catch(() => null)
    if (!handle) continue
    const n = await handle.evaluate((rows: unknown) => (Array.isArray(rows) ? rows.length : 0)).catch(() => 0)
    count = Math.max(count, n)
    await handle.dispose().catch(() => {})
  }
  return count
}

async function clickSnapshotMenu(page: Page, target: { name: string; id: string }): Promise<boolean> {
  for (const frame of page.frames()) {
    const rows = await frame.evaluateHandle(matchingSnapshotRows, target).catch(() => null)
    if (!rows) continue
    const row = await rows.evaluateHandle((found: unknown) => (Array.isArray(found) && found.length === 1 ? found[0] : null)).catch(() => null)
    await rows.dispose().catch(() => {})
    const rowEl = row && 'asElement' in row ? row.asElement() : null
    if (!rowEl) {
      await row?.dispose().catch(() => {})
      continue
    }
    try {
      const menu = await rowEl.evaluateHandle(locateRowMenu).catch(() => null)
      const menuEl = menu && 'asElement' in menu ? menu.asElement() : null
      if (!menuEl) {
        await menu?.dispose().catch(() => {})
        return false
      }
      try {
        await menuEl.click({ timeout: 3000 })
        return true
      } finally {
        await menuEl.dispose().catch(() => {})
      }
    } finally {
      await rowEl.dispose().catch(() => {})
    }
  }
  return false
}

async function clickDialogChoice(page: Page, label: string): Promise<boolean> {
  if (isUnsafeSnapshotControl(label)) return false
  return page
    .evaluate((wanted) => {
      const norm = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase()
      const want = norm(wanted)
      const root = document.querySelector('[role="dialog"], [aria-modal="true"]') || document.body
      const nodes = Array.from(root.querySelectorAll('[role="option"], [role="checkbox"], [role="radio"], label, li'))
      const hit = nodes.find((el) => norm(el.textContent || '') === want)
      if (!hit) return false
      const box =
        hit.querySelector('input[type="checkbox"], [role="checkbox"]') ||
        (hit.getAttribute('role') === 'checkbox' ? hit : null)
      const target = box || hit
      if (!box && target.closest('a')) return false
      ;(target as HTMLElement).click()
      return true
    }, label)
    .catch(() => false)
}

async function fillDialogSearch(page: Page, text: string): Promise<boolean> {
  return page
    .evaluate((value) => {
      const root = document.querySelector('[role="dialog"], [aria-modal="true"]')
      if (!root) return false
      const inputs = Array.from(root.querySelectorAll('input, textarea')) as HTMLInputElement[]
      const blobOf = (el: HTMLInputElement) => `${el.placeholder || ''} ${el.getAttribute('aria-label') || ''} ${el.name || ''}`.toLowerCase()
      const input =
        inputs.find((el) => /search|sub-account|subaccount|location|account/.test(blobOf(el))) ||
        inputs.find((el) => !el.type || el.type === 'text' || el.type === 'search')
      if (!input) return false
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
      if (desc && desc.set) desc.set.call(input, value)
      else input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }, text)
    .catch(() => false)
}

export type AgencyPushResult = {
  busy: boolean
  confirmed: boolean
  notes: string[]
  shots: { step: string; image: Buffer }[]
  rows: SnapshotRow[]
}

/**
 * Push one snapshot into one existing location from Account Snapshots.
 * Aborts when the location match is missing or ambiguous. Does not create or delete.
 */
export async function pushSnapshotToLocation(opts: {
  locationId: string
  locationName: string
  snapshotId: string
  snapshotName: string
  origin: string
  labels: GhlLabels
  storageState: string | null
  headless: boolean
  executablePath?: string
}): Promise<AgencyPushResult> {
  const notes: string[] = []
  const shots: { step: string; image: Buffer }[] = []
  const opened = await openWorkerBrowser(opts)
  if (!opened) {
    return { busy: true, confirmed: false, notes: ['Snapshot push skipped: a browser is already open.'], shots, rows: [] }
  }
  const { browser, context, page } = opened
  const bucket: { url: string; body: unknown }[] = []
  watchSnapshotResponses(page, bucket)
  const target = { name: opts.snapshotName, id: opts.snapshotId }
  let confirmed = false
  const shoot = async (step: string) => {
    try {
      shots.push({ step, image: await capturePage(page) })
    } catch {
      // A shot is optional.
    }
  }
  try {
    const onPage = await openAgencySnapshotPage(page, opts.origin, opts.labels, notes)
    if (!onPage) return { busy: false, confirmed: false, notes, shots, rows: catalogFrom(bucket) }
    let matches = await rowCount(page, target)
    if (matches !== 1) {
      for (const tab of SNAPSHOT_TABS) {
        const seen = await pageLabels(page)
        const visible = seen.find((label) => label.toLowerCase().startsWith(tab.toLowerCase()))
        if (!visible) continue
        if (!(await clickSafe(page, opts.labels, visible, false, notes))) continue
        notes.push(`Opened tab "${visible}" to find snapshot ${opts.snapshotId}.`)
        await page.waitForTimeout(1200)
        matches = await rowCount(page, target)
        if (matches === 1) break
      }
    }
    await shoot('snapshot push list')
    const listed = await fetchSnapshotBodies(page, [])
    bucket.push(...listed)
    const known = catalogFrom(bucket)
    const sameName = known.filter(
      (row) => row.name.trim().toLowerCase() === opts.snapshotName.trim().toLowerCase() && row.id !== opts.snapshotId,
    )
    const showsId = opts.snapshotId
      ? await page.evaluate((id) => (document.documentElement ? document.documentElement.innerHTML.includes(id) : false), opts.snapshotId).catch(() => false)
      : false
    if (!known.length) {
      notes.push(`The snapshot list JSON was not read before the push. The row match is "${opts.snapshotName}" (${opts.snapshotId}).`)
    }
    if (matches === 1 && sameName.length > 0 && !showsId) {
      const seen = await pageLabels(page)
      notes.push(
        `The visible "${opts.snapshotName}" row does not contain snapshot id ${opts.snapshotId}. Other snapshots with that name: ${sameName
          .map((row) => `${row.id} (${describeAssetCounts(row.counts)})`)
          .join('; ')}. Visible controls: ${visibleControls(seen)}. Nothing was pushed.`,
      )
      return { busy: false, confirmed: false, notes, shots, rows: known }
    }
    if (matches !== 1) {
      const seen = await pageLabels(page)
      notes.push(
        matches === 0
          ? `No snapshot row matched ${opts.snapshotName} (${opts.snapshotId}). Visible controls: ${visibleControls(seen)}. Nothing was pushed.`
          : `Several snapshot rows matched ${opts.snapshotName} (${opts.snapshotId}). Visible controls: ${visibleControls(seen)}. Nothing was pushed.`,
      )
      return { busy: false, confirmed: false, notes, shots, rows: catalogFrom(bucket) }
    }
    const menuOpened = await clickSnapshotMenu(page, target)
    await page.waitForTimeout(800)
    const menuLabels = await pageLabels(page)
    if (!menuOpened) {
      notes.push(`The snapshot action menu was not found for ${opts.snapshotId}. Visible controls: ${visibleControls(menuLabels)}. Nothing was pushed.`)
      await shoot('snapshot push menu missing')
      return { busy: false, confirmed: false, notes, shots, rows: catalogFrom(bucket) }
    }
    const menu = chooseSnapshotMenuAction(menuLabels)
    if (!menu.ok) {
      notes.push(menu.reason)
      await shoot('snapshot push menu')
      return { busy: false, confirmed: false, notes, shots, rows: catalogFrom(bucket) }
    }
    notes.push(`Snapshot menu item: "${menu.label}".`)
    if (!(await clickSafe(page, opts.labels, menu.label, false, notes))) {
      await shoot('snapshot push menu')
      return { busy: false, confirmed: false, notes, shots, rows: catalogFrom(bucket) }
    }
    await page.waitForTimeout(1200)
    if (!agencyPushUrlAllowed(page.url())) {
      notes.push(`Stopped after the menu. The page is ${page.url()}. Nothing was confirmed.`)
      await shoot('snapshot push left page')
      return { busy: false, confirmed: false, notes, shots, rows: catalogFrom(bucket) }
    }
    let options = await page.evaluate(dialogChoiceLabels as () => string[]).catch(() => [] as string[])
    let choice = chooseLocationTarget(options, opts.locationId, opts.locationName)
    if (!choice.ok) {
      const query = opts.locationName || opts.locationId
      const typed = await fillDialogSearch(page, query)
      notes.push(typed ? `Typed "${query}" into the location search.` : `The push dialog had no location search. Visible locations: ${visibleControls(options)}.`)
      if (typed) {
        await page.waitForTimeout(1000)
        options = await page.evaluate(dialogChoiceLabels as () => string[]).catch(() => [] as string[])
        choice = chooseLocationTarget(options, opts.locationId, opts.locationName)
      }
    }
    await shoot('snapshot push dialog')
    if (!choice.ok) {
      notes.push(choice.reason)
      return { busy: false, confirmed: false, notes, shots, rows: catalogFrom(bucket) }
    }
    const picked = await clickDialogChoice(page, choice.label)
    if (!picked) {
      const seen = await pageLabels(page)
      notes.push(`Could not select location "${choice.label}". Visible controls: ${visibleControls(seen)}. Nothing was confirmed.`)
      return { busy: false, confirmed: false, notes, shots, rows: catalogFrom(bucket) }
    }
    notes.push(`Selected location "${choice.label}" only.`)
    await page.waitForTimeout(800)
    if (!agencyPushUrlAllowed(page.url())) {
      notes.push(`Selecting the location opened ${page.url()}. The push was not confirmed.`)
      await shoot('snapshot push left page')
      return { busy: false, confirmed: false, notes, shots, rows: catalogFrom(bucket) }
    }
    let overwriteOn = false
    for (let step = 0; step < 4; step++) {
      const snap = await snapshotPage(page, opts.labels)
      const ow = overwriteControl(snap.checks || [], [...(snap.buttons || []), ...((snap.checks || []).map((item) => item.text))])
      if (!overwriteOn) {
        if (!ow) {
          notes.push(`Overwrite was not on the push dialog. Visible controls: ${visibleControls([...(snap.buttons || []), ...(snap.checks || []).map((item) => item.text)])}. The push was not confirmed.`)
          break
        }
        if (ow.alreadyOn) {
          overwriteOn = true
          notes.push(`Overwrite is already on ("${ow.label}").`)
        } else {
          const landed = await clickSafe(page, opts.labels, ow.label, true, notes)
          if (!landed) break
          overwriteOn = true
          notes.push(`Pressed overwrite "${ow.label}".`)
          await page.waitForTimeout(800)
          continue
        }
      }
      const confirm = confirmPushControl(snap.buttons || [])
      if (!confirm) {
        notes.push(`The push dialog had no confirm button. Visible controls: ${visibleControls(snap.buttons || [])}. Nothing else was clicked.`)
        break
      }
      const landed = await clickSafe(page, opts.labels, confirm.label, false, notes)
      if (!landed) break
      notes.push(`Pressed "${confirm.label}".`)
      if (!agencyPushUrlAllowed(page.url())) {
        notes.push(`The page left the agency snapshot flow for ${page.url()}.`)
        confirmed = false
        break
      }
      if (confirm.finishes) {
        confirmed = true
        break
      }
      await page.waitForTimeout(1000)
    }
    await shoot(confirmed ? 'snapshot push confirmed' : 'snapshot push stopped')
    const fetched = await fetchSnapshotBodies(page, [opts.snapshotId])
    bucket.push(...fetched)
    return { busy: false, confirmed, notes, shots, rows: catalogFrom(bucket) }
  } finally {
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
    browserOpen = false
  }
}
