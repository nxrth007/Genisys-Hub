/**
 * Playwright side of the GHL route of a client's toll-free number, run after
 * someone passed GHL's ID check for the client's sub-account and pressed
 * "Identification complete" in the Office:
 *   1. a toll-free number already in the sub-account (the one bought during
 *      the ID check) is taken as it is;
 *   2. otherwise one toll-free number is bought there, remembering which
 *      number was picked before "Proceed to Buy" so a crash never leads to a
 *      second buy; GHL's identity check showing up means it isn't done yet;
 *   3. its calls are pointed at the client's phone (External Phone Number).
 *
 * GHL's identity check (Persona) is never started here: only a person does
 * it. The buy screens were mapped and used live on 2026-11-12/13 (Lead
 * Genisys bought (855) 676-2067 with this code). Tests never import this file.
 */
import type { BrowserContext, Locator, Page } from 'playwright'
import { capturePage, claimBrowser, newWorkerContext, releaseBrowser, signInOnPage } from '@/lib/ghl-subaccount-worker/browser'
import { chromiumLaunchArgs, prepareChromiumEnv } from '@/lib/ghl-subaccount-worker/chromium-host'
import type { GhlLabels } from '@/lib/ghl-subaccount-worker/labels'
import type { PageSnap } from '@/lib/ghl-subaccount-worker/plan'
import { adoptable, CONFIRM_BUY, displayNumber, e164, forwardingFrom, isIdentityCheck, MAX_TOLL_FREE_PRICE, parseBuyRow, pickTollFree, type ListedNumber } from './plan'
import { pickOption, type FormField, type GhlForm } from './register-plan'

export type GhlNumberState = { pickedNumber: string | null; buyStartedAt: Date | null; phoneNumber: string | null }

export type GhlNumberOptions = {
  clientName: string
  locationId: string
  /** The client's phone the calls should ring (E.164). */
  businessPhone: string
  state: GhlNumberState
  /** false = dry run: stop before "Proceed to Buy". */
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
  /** Saved before "Proceed to Buy" is pressed. */
  onPicked: (number: string) => Promise<void>
  /** The identity check stopped the buy: nothing was bought. */
  onBuyAbandoned: () => Promise<void>
  onNumber: (number: string) => Promise<void>
}

export type GhlNumberResult = {
  /** done: the sub-account has its number and calls are pointed. needs_identity: GHL still wants the ID check. */
  status: 'done' | 'rehearsed' | 'needs_identity' | 'needs_human' | 'error'
  detail: string
  phoneNumber?: string
  forwardsTo?: string
  /** The number was already there (bought during the ID check), not bought by this run. */
  adopted?: boolean
  storageState: string | null
}

const APP = 'https://app.gohighlevel.com'

/** Dry-run mode stopped right before the purchase. */
class Rehearsed extends Error {}

class Halt extends Error {
  constructor(
    readonly status: 'needs_identity' | 'needs_human' | 'error',
    message: string,
  ) {
    super(message)
  }
}

const phoneSystemUrl = (locationId: string) => `${APP}/v2/location/${locationId}/settings/phone_system?tab=manage`

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

async function visibleIn(loc: Locator): Promise<Locator | null> {
  const n = await loc.count().catch(() => 0)
  for (let i = 0; i < Math.min(n, 30); i++) {
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

/** All text on the page, frames included (GHL's identity check runs in its own frame). */
async function allText(page: Page): Promise<string> {
  const parts: string[] = []
  for (const frame of page.frames()) {
    parts.push(await frame.evaluate(() => (document.body && document.body.innerText) || '').catch(() => ''))
  }
  return parts.join('\n')
}

async function identityCheckShowing(page: Page): Promise<boolean> {
  if (page.frames().some((f) => /withpersona\.com/i.test(f.url()))) return true
  return isIdentityCheck(await allText(page))
}

type Run = { opts: GhlNumberOptions; context: BrowserContext; page: Page; note: (l: string) => Promise<void>; shoot: (s: string) => Promise<void> }

/** What every run needs, a purchase or a registration. */
export type GhlBaseOptions = Pick<
  GhlNumberOptions,
  'clientName' | 'locationId' | 'labels' | 'login' | 'storageState' | 'headless' | 'executablePath' | 'signal' | 'pullOtp' | 'onOtpPrompt' | 'onNote' | 'capture'
>
type PageRun = { page: Page; opts: GhlBaseOptions; note: (l: string) => Promise<void>; shoot: (s: string) => Promise<void> }

function signedInPage(snap: PageSnap): boolean {
  try {
    const u = new URL(snap.url)
    return /(gohighlevel|leadconnectorhq)\.com$/i.test(u.hostname) && /^\/(v2\/location\/|location\/|agency_dashboard|sub-accounts|settings\/|agency\/|accounts)/i.test(u.pathname)
  } catch {
    return false
  }
}

/** Open the sub-account's Phone System → Manage Numbers, signing in first if GHL asks. */
async function openPhoneSystem(run: PageRun): Promise<void> {
  const { page, opts } = run
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(phoneSystemUrl(opts.locationId), { waitUntil: 'domcontentloaded', timeout: 60_000 })
    const deadline = Date.now() + 60_000
    let login = false
    for (;;) {
      if (await visibleIn(page.locator('input[type="password"]'))) {
        login = true
        break
      }
      const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '')
      if (/Manage Numbers/.test(text) && (/No Data/.test(text) || /\d{3}-\d{3}-\d{4}|\+\d{6,}/.test(text))) {
        // A table that is still loading can flash "No Data"; let it settle before anyone reads it.
        await sleep(2500, opts.signal)
        return
      }
      if (Date.now() >= deadline) break
      await sleep(700, opts.signal)
    }
    if (!login) throw new Halt('error', "GHL's Phone System page didn't load.")
    await run.note('GHL asked to sign in. Signing in with the agency login.')
    const res = await signInOnPage(page, {
      label: `${opts.clientName}'s number`,
      homeUrl: phoneSystemUrl(opts.locationId),
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
  }
  throw new Halt('error', "GHL's Phone System page didn't load after signing in.")
}

/** The numbers on the open Manage Numbers page, and which are toll-free. */
async function listedRows(page: Page): Promise<ListedNumber[]> {
  const rows = await page
    .evaluate(async () => {
      const seen = new Map<string, boolean>()
      const grab = () => {
        for (const r of Array.from(document.querySelectorAll('tr'))) {
          const t = (r as HTMLElement).innerText.replace(/\s+/g, ' ').trim()
          if (/\$\d/.test(t)) continue
          const m = /\+\d[\d\s().-]{6,}\d/.exec(t)
          if (m) seen.set(m[0], seen.get(m[0]) || /toll\s*free/i.test(t))
        }
      }
      grab()
      const scrollers = Array.from(document.querySelectorAll('*')).filter((el) => el.scrollHeight > el.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(el).overflowY) && el.querySelector('tr'))
      for (const s of scrollers) {
        for (let y = 0; y <= s.scrollHeight; y += 250) {
          s.scrollTop = y
          await new Promise((r) => setTimeout(r, 120))
          grab()
        }
        s.scrollTop = 0
      }
      return Array.from(seen.entries())
    })
    .catch(() => [] as [string, boolean][])
  return rows.map(([raw, tollFree]) => ({ number: e164(raw) || raw.replace(/\s+/g, ' '), tollFree }))
}

/** Buy one toll-free number in the client's sub-account. Returns it (E.164). */
async function buyNumber(run: Run): Promise<string> {
  const { page, opts } = run
  const before = (await listedRows(page)).map((r) => r.number)
  const add = await waitVisible(page.locator('button').filter({ hasText: /^\s*\+?\s*Add Number\s*$/ }), 20_000, opts.signal)
  if (!add) throw new Halt('error', `Couldn't find "Add Number" in the sub-account's Phone System.`)
  await add.click({ timeout: 8000 })
  const item = await waitVisible(page.getByText('Add Phone Number', { exact: true }), 10_000, opts.signal)
  if (!item) throw new Halt('error', 'The Add Number menu had no "Add Phone Number".')
  await item.click({ timeout: 8000 })

  let picked: ReturnType<typeof pickTollFree> = null
  for (let round = 0; round < 4 && !picked; round++) {
    if (round > 0) {
      const refresh = await visibleIn(page.locator('button').filter({ hasText: /Refresh Results/ }))
      if (refresh) await refresh.click({ timeout: 5000 }).catch(() => {})
    }
    const deadline = Date.now() + 25_000
    for (;;) {
      const texts = await page.evaluate(() => Array.from(document.querySelectorAll('tr')).map((r) => (r as HTMLElement).innerText)).catch(() => [] as string[])
      const rows = texts.map(parseBuyRow).filter((r) => r && r.price !== null)
      picked = pickTollFree(rows.filter((r) => r && !before.includes(r.number)))
      if (picked || (rows.length && Date.now() > deadline - 20_000) || Date.now() >= deadline) break
      await sleep(800, opts.signal)
    }
  }
  if (!picked) throw new Halt('error', `GHL offered no toll-free number at $${MAX_TOLL_FREE_PRICE.toFixed(2)}/month or less.`)
  const dashed = picked.text.match(/\d{3}-\d{3}-\d{4}/)?.[0] ?? displayNumber(picked.number)
  const row = page.locator('tr').filter({ hasText: dashed })
  await row.locator('label.hr-radio').first().click({ timeout: 8000 })
  await sleep(700, opts.signal)
  const summary = (await page.evaluate(() => document.body?.innerText || '').catch(() => '')).replace(/\s+/g, ' ')
  const total = /Total Amount:\s*\$\s*([\d.]+)/.exec(summary)?.[1]
  if (!/\b1 Number selected\b/i.test(summary) || !total || Number(total) > MAX_TOLL_FREE_PRICE) {
    throw new Halt('error', `The buy dialog didn't show exactly one toll-free number selected at $${picked.price}/month (it says "${/\d+ Numbers? selected/i.exec(summary)?.[0] ?? '?'}", total $${total ?? '?'}). Nothing was bought.`)
  }
  await run.note(`Picked ${displayNumber(picked.number)} (${picked.text}). Total $${total}/month.`)
  await run.shoot('picked toll-free number')
  if (!opts.save) throw new Rehearsed(`Dry run: stopped before buying ${displayNumber(picked.number)}. Nothing was bought.`)

  await opts.onPicked(picked.number)
  const proceed = await visibleIn(page.locator('button').filter({ hasText: /Proceed to Buy/ }))
  if (!proceed || !(await proceed.isEnabled().catch(() => false))) throw new Halt('error', '"Proceed to Buy" was not available.')
  await proceed.click({ timeout: 8000 })

  // What follows: GHL's identity check (stop), a confirmation (press it), or the purchase itself.
  let confirmed = false
  const deadline = Date.now() + 90_000
  for (;;) {
    await sleep(1500, opts.signal)
    if (await identityCheckShowing(page)) {
      await run.shoot('identity check')
      await opts.onBuyAbandoned()
      throw new Halt(
        'needs_identity',
        `GHL still asks for its identity check in ${opts.clientName}'s sub-account, so nothing was bought. Finish it in GHL (Phone System → Add Number → Proceed to Buy), then press Identification complete again.`,
      )
    }
    if (!confirmed) {
      const dialogs = page.locator('.hr-modal, [role="dialog"], [aria-modal="true"]')
      const confirm = await visibleIn(dialogs.locator('button').filter({ hasText: CONFIRM_BUY }))
      if (confirm && (await confirm.isEnabled().catch(() => false))) {
        const label = ((await confirm.innerText().catch(() => '')) || '').trim()
        await run.note(`GHL asked to confirm the purchase; pressing "${label}".`)
        await run.shoot('purchase confirmation')
        await confirm.click({ timeout: 8000 })
        confirmed = true
        continue
      }
    }
    const buyDialogOpen = !!(await visibleIn(page.getByText('Buy your Number', { exact: true })))
    if (!buyDialogOpen) break
    if (Date.now() >= deadline) {
      await run.shoot('purchase stuck')
      throw new Halt('needs_human', `Pressed Proceed to Buy for ${displayNumber(picked.number)} but GHL never finished or asked anything the Hub knows. Check the sub-account's numbers before trying again, in case it was bought.`)
    }
  }
  for (let i = 0; i < 6; i++) {
    await openPhoneSystem(run)
    if ((await listedRows(page)).some((r) => r.number === picked.number)) {
      await run.note(`Bought ${displayNumber(picked.number)} in ${opts.clientName}'s sub-account.`)
      return picked.number
    }
    await sleep(10_000, opts.signal)
  }
  await run.shoot('bought number missing')
  throw new Halt('needs_human', `Pressed Buy for ${displayNumber(picked.number)} but it isn't in the sub-account's numbers. Check whether it was charged before trying again.`)
}

/** Read where the number's calls ring; point them at the client's phone if they don't already go there. */
async function checkForwarding(run: Run, number: string): Promise<{ forwardsTo: string; note: string }> {
  const { page, opts } = run
  const want = e164(opts.businessPhone)
  const dashed = displayNumber(number).replace(/[()]/g, '').replace(' ', '-')
  const openConfig = async (): Promise<Locator> => {
    await openPhoneSystem(run)
    await page.evaluate(() => {
      for (const el of Array.from(document.querySelectorAll('*'))) {
        if (el.scrollWidth > el.clientWidth + 30 && /auto|scroll/.test(getComputedStyle(el).overflowX) && el.querySelector('tr')) el.scrollLeft = el.scrollWidth
      }
    })
    const row = page.locator('tr').filter({ hasText: dashed }).first()
    await row.locator('td').last().click({ timeout: 8000 })
    const edit = await waitVisible(page.getByText('Edit Configuration', { exact: true }), 8000, opts.signal)
    if (!edit) throw new Halt('needs_human', `Couldn't open the settings of ${displayNumber(number)} to check its call forwarding.`)
    await edit.click({ timeout: 8000 })
    const modal = page.locator('.hr-modal, [role="dialog"]').filter({ hasText: /Configure/ }).last()
    if (!(await waitVisible(modal, 10_000, opts.signal))) throw new Halt('needs_human', `The settings of ${displayNumber(number)} didn't open.`)
    await sleep(1200, opts.signal)
    const tab = await visibleIn(modal.getByText('Call Forwarding', { exact: true }))
    if (tab) await tab.click({ timeout: 5000 }).catch(() => {})
    await sleep(800, opts.signal)
    return modal
  }
  const close = async (modal: Locator) => {
    const cancel = await visibleIn(modal.locator('button').filter({ hasText: /^\s*Cancel\s*$/ }))
    if (cancel) await cancel.click({ timeout: 5000 }).catch(() => {})
  }
  let modal = await openConfig()
  let routes = forwardingFrom((await modal.innerText().catch(() => '')) || '')
  await run.note(`${displayNumber(number)} rings: external ${routes.external || '(none)'}, business phone ${routes.business || '(none)'}.`)
  if (want && (routes.external === want || (!routes.external && routes.business === want))) {
    await close(modal)
    return { forwardsTo: want, note: `Calls ring the client's phone ${displayNumber(want)}${routes.external ? '' : " (the sub-account's business phone)"}.` }
  }
  if (!want) {
    await close(modal)
    return { forwardsTo: routes.external || routes.business, note: "The client's phone isn't on file, so the call forwarding was left as GHL set it." }
  }
  const input = await visibleIn(modal.locator('input[type="tel"]'))
  if (!input) {
    await close(modal)
    throw new Halt('needs_human', `${displayNumber(number)} rings ${routes.external || routes.business || 'nobody'}, not the client's ${displayNumber(want)}, and the External Phone Number box wasn't found. Set it in GHL (number → Edit Configuration).`)
  }
  await input.fill(want.slice(2))
  const save = await visibleIn(modal.locator('button').filter({ hasText: /^\s*Save\s*$/ }))
  if (!save) throw new Halt('needs_human', `Couldn't find Save in the settings of ${displayNumber(number)}.`)
  await save.click({ timeout: 8000 })
  await sleep(2500, opts.signal)
  modal = await openConfig()
  routes = forwardingFrom((await modal.innerText().catch(() => '')) || '')
  await close(modal)
  if (routes.external !== want) {
    throw new Halt('needs_human', `Set ${displayNumber(number)} to forward to ${displayNumber(want)}, but GHL shows ${routes.external || 'nothing'}. Check it in GHL.`)
  }
  return { forwardsTo: want, note: `Calls now forward to the client's phone ${displayNumber(want)} (External Phone Number).` }
}

async function sessionOf(context: BrowserContext): Promise<string | null> {
  try {
    return JSON.stringify(await context.storageState())
  } catch {
    return null
  }
}

export async function runGhlNumber(opts: GhlNumberOptions): Promise<GhlNumberResult> {
  if (opts.signal?.aborted) throw new Error('The job ran out of time.')
  claimBrowser()
  let context: BrowserContext | null = null
  let close: (() => Promise<void>) | null = null
  try {
    prepareChromiumEnv()
    const pw = (await import('playwright')) as typeof import('playwright')
    const browser = await pw.chromium.launch({ headless: opts.headless, executablePath: opts.executablePath || undefined, args: chromiumLaunchArgs() })
    close = () => browser.close()
    opts.signal?.addEventListener('abort', () => void browser.close().catch(() => {}), { once: true })
    context = await newWorkerContext(browser, opts.storageState)
    const page = await context.newPage()
    page.setDefaultTimeout(20_000)
    page.on('dialog', (d) => {
      void d.dismiss().catch(() => {})
    })
    const run: Run = {
      opts,
      context,
      page,
      note: async (line) => {
        await opts.onNote(line).catch(() => {})
      },
      shoot: async (step) => {
        try {
          await opts.capture(step, await capturePage(page))
        } catch {
          // A missing picture never stops the run.
        }
      },
    }
    const st = opts.state
    try {
      await openPhoneSystem(run)
      const rows = await listedRows(page)
      let number: string | null = null
      let adopted = false
      if (st.phoneNumber && rows.some((r) => r.number === st.phoneNumber)) {
        number = st.phoneNumber
      } else if (adoptable(rows)) {
        number = adoptable(rows)
        adopted = true
        await run.note(`The sub-account already has ${displayNumber(number!)} (bought during the ID check); using it instead of buying another.`)
      } else if (st.pickedNumber && st.buyStartedAt) {
        // An earlier run pressed Buy and never saw the number: never buy blind.
        return {
          status: 'needs_human',
          detail: `An earlier run pressed Buy for ${displayNumber(st.pickedNumber)}, and it isn't in the sub-account. Check its numbers and GHL billing before trying again, so it isn't bought twice.`,
          storageState: await sessionOf(context),
        }
      } else {
        number = await buyNumber(run)
      }
      await opts.onNumber(number!)
      try {
        const f = await checkForwarding(run, number!)
        return { status: 'done', detail: `${displayNumber(number!)} is ${opts.clientName}'s toll-free number in GHL. ${f.note}`, phoneNumber: number!, forwardsTo: f.forwardsTo, adopted, storageState: await sessionOf(context) }
      } catch (err) {
        if (!(err instanceof Halt)) throw err
        await run.shoot('forwarding')
        return { status: 'needs_human', detail: `${displayNumber(number!)} is ${opts.clientName}'s toll-free number in GHL. ${err.message}`, phoneNumber: number!, adopted, storageState: await sessionOf(context) }
      }
    } catch (err) {
      if (opts.signal?.aborted) throw err
      await run.shoot('failure')
      if (err instanceof Rehearsed) return { status: 'rehearsed', detail: err.message, storageState: await sessionOf(context) }
      if (err instanceof Halt) return { status: err.status, detail: err.message, storageState: await sessionOf(context) }
      throw err
    }
  } finally {
    await context?.close().catch(() => {})
    await close?.().catch(() => {})
    releaseBrowser()
  }
}

// ---------------------------------------------------------------------------
// GHL's toll-free registration form ("Messaging Toll-Free Verification")
// ---------------------------------------------------------------------------

export type GhlRegisterOptions = GhlBaseOptions & {
  /** The client's toll-free number in GHL (E.164). */
  number: string
  form: GhlForm
  /** false: fill every step, stop before "Send Information for Verification" (for a person's OK). */
  submit: boolean
}

export type GhlRegisterResult = {
  /** review: filled and stopped before sending. already: GHL no longer shows "Verification Required". */
  status: 'review' | 'submitted' | 'already' | 'needs_human' | 'error'
  detail: string
  storageState: string | null
}

const SEND_BUTTON = /^\s*Send Information for Verification\s*$/i
const NEXT_BUTTON = /^\s*(Continue|Next|Review)\b/i

/** Tag the control that follows a label (by the label's own text) in the open form; Playwright then drives it. */
async function markControl(page: Page, label: string, key: string): Promise<'text' | 'select' | null> {
  return page.evaluate(
    ({ label, key }) => {
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
      const want = norm(label)
      const vis = (e: Element) => {
        const r = (e as HTMLElement).getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const own = (e: Element) =>
        Array.from(e.childNodes)
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent || '')
          .join(' ')
      const modal = Array.from(document.querySelectorAll('.hr-modal')).filter(vis).find((m) => /Toll-Free/i.test((m as HTMLElement).innerText))
      if (!modal) return null
      // An exact label first ("Country"), then one that starts with it ("State, province, or region"),
      // so a shorter wanted label never lands on a longer one ("Country Code").
      const labels = Array.from(modal.querySelectorAll('*')).filter(vis).map((e) => ({ e, t: norm(own(e)) }))
      const hit = (labels.find((x) => x.t === want) ?? labels.find((x) => x.t.startsWith(`${want} `)))?.e
      if (!hit) return null
      const controls = Array.from(modal.querySelectorAll('input.hr-input__input-el, textarea, .hr-select')).filter(vis)
      const next = controls.find((c) => !!(hit.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING))
      if (!next) return null
      document.querySelectorAll('[data-ghfill]').forEach((e) => e.getAttribute('data-ghfill') === key && e.removeAttribute('data-ghfill'))
      next.setAttribute('data-ghfill', key)
      return next.classList.contains('hr-select') ? 'select' : 'text'
    },
    { label, key },
  )
}

async function visibleOptions(page: Page): Promise<string[]> {
  return page
    .locator('.hr-base-select-option')
    .evaluateAll((els) => els.filter((e) => (e as HTMLElement).getBoundingClientRect().height > 0).map((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim()))
    .catch(() => [] as string[])
}

/** Pick in one of the form's lists (every wanted value for a multi list). Returns what was picked, or throws naming what wasn't there. */
async function chooseIn(run: PageRun, key: string, field: FormField): Promise<string[]> {
  const { page, opts } = run
  const sel = page.locator(`[data-ghfill="${key}"]`)
  const picked: string[] = []
  const wants = field.kind === 'multi' ? field.value.map((v) => [v]) : [field.value]
  for (const want of wants) {
    let options = await visibleOptions(page)
    if (!options.length) {
      await sel.click({ timeout: 8000 })
      await sleep(600, opts.signal)
      options = await visibleOptions(page)
    }
    let pick = pickOption(options, want)
    if (!pick) {
      // A long list (states, countries) may only render what matches what's typed.
      await page.keyboard.type(want[0], { delay: 15 })
      await sleep(800, opts.signal)
      options = await visibleOptions(page)
      pick = pickOption(options, want)
    }
    if (!pick) throw new Halt('needs_human', `GHL's "${field.label}" list has no "${want.join('" or "')}" (it offers ${options.slice(0, 12).join(', ') || 'nothing'}). Nothing was sent.`)
    const option = page.locator('.hr-base-select-option').filter({ hasText: new RegExp(`^\\s*${pick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) }).first()
    await option.click({ timeout: 8000 })
    picked.push(pick)
    await sleep(400, opts.signal)
  }
  // A multi list stays open: close it on the form's title.
  if (field.kind === 'multi') await page.locator('.hr-modal').getByText(/Toll-Free Verification/).first().click({ timeout: 4000 }).catch(() => {})
  const shown = ((await sel.innerText().catch(() => '')) || '').replace(/\s+/g, ' ')
  for (const p of picked) if (!shown.includes(p)) throw new Halt('needs_human', `Picked "${p}" for "${field.label}" but GHL shows "${shown}". Nothing was sent.`)
  return picked
}

/** Fill one step's fields by their labels. */
async function fillStep(run: PageRun, fields: FormField[], step: number): Promise<void> {
  const { page } = run
  for (const [i, field] of fields.entries()) {
    const value = field.value.find((v) => v.trim()) ?? ''
    if (!value && field.optional) continue
    const key = `s${step}f${i}`
    const kind = await markControl(page, field.label, key)
    if (!kind) {
      if (field.optional) continue
      throw new Halt('needs_human', `Step ${step} of GHL's toll-free form has no "${field.label}" field the Hub knows. Nothing was sent.`)
    }
    if (kind === 'select' || field.kind !== 'text') {
      if (kind !== 'select') throw new Halt('needs_human', `GHL's "${field.label}" is a text box, not a list. Nothing was sent.`)
      await chooseIn(run, key, field)
    } else {
      const box = page.locator(`[data-ghfill="${key}"]`)
      await box.click({ timeout: 8000 })
      await box.fill(value)
    }
  }
}

/** The form's step marker and any error GHL shows. */
async function formState(page: Page): Promise<{ text: string; errors: string[] }> {
  return page.evaluate(() => {
    const vis = (e: Element) => (e as HTMLElement).getBoundingClientRect().height > 0
    const modal = Array.from(document.querySelectorAll('.hr-modal')).filter(vis).find((m) => /Toll-Free/i.test((m as HTMLElement).innerText))
    const text = modal ? (modal as HTMLElement).innerText.replace(/\s+/g, ' ') : ''
    const errors = modal
      ? Array.from(modal.querySelectorAll('[class*="feedback"], [class*="error"]'))
          .filter(vis)
          .map((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim())
          .filter(Boolean)
      : []
    return { text, errors: Array.from(new Set(errors)).slice(0, 6) }
  })
}

/** Is a field with this label showing in the open form? */
async function hasLabel(page: Page, label: string): Promise<boolean> {
  return page.evaluate((label) => {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    const want = norm(label)
    const modal = Array.from(document.querySelectorAll('.hr-modal')).find((m) => (m as HTMLElement).getBoundingClientRect().height > 0 && /Toll-Free/i.test((m as HTMLElement).innerText))
    if (!modal) return false
    return Array.from(modal.querySelectorAll('*')).some((e) => {
      if ((e as HTMLElement).getBoundingClientRect().height === 0) return false
      const own = norm(Array.from(e.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent || '').join(' '))
      return own === want || own.startsWith(`${want} `)
    })
  }, label)
}

/**
 * Press the step's Continue and wait until the next step is drawn: the form's
 * text changed and held still for a poll, no errors, and (when known) the next
 * step's first field showing. Otherwise say what GHL objected to.
 */
async function nextStep(run: PageRun, step: number, nextLabel?: string): Promise<void> {
  const { page, opts } = run
  const before = (await formState(page)).text
  const button = await visibleIn(page.locator('.hr-modal button').filter({ hasText: NEXT_BUTTON }))
  if (!button) throw new Halt('needs_human', `Step ${step} of GHL's toll-free form has no Continue button the Hub knows. Nothing was sent.`)
  await button.click({ timeout: 8000 })
  const deadline = Date.now() + 25_000
  let last = before
  for (;;) {
    await sleep(1000, opts.signal)
    const now = await formState(page)
    const settled = !!now.text && now.text !== before && now.text === last
    last = now.text
    if (settled && !now.errors.length && (!nextLabel || (await hasLabel(page, nextLabel)))) return
    if (Date.now() >= deadline) {
      await run.shoot(`toll-free form step ${step} stuck`)
      throw new Halt('needs_human', `GHL didn't move past step ${step} of the toll-free form${now.errors.length ? `: ${now.errors.join('; ')}` : ''}. Nothing was sent.`)
    }
  }
}

/** Close the form without sending. */
async function closeForm(page: Page): Promise<void> {
  const close = await visibleIn(page.locator('.hr-modal').filter({ hasText: /Toll-Free/ }).locator('.hr-base-close, [aria-label="close"], [aria-label="Close"], button:has(svg)').first())
  if (close) await close.click({ timeout: 4000 }).catch(() => {})
}

/** The number's row on Manage Numbers, as text. */
async function numberRow(page: Page, number: string): Promise<string> {
  const dashed = displayNumber(number).replace(/[()]/g, '').replace(' ', '-')
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll('tr')).map((r) => (r as HTMLElement).innerText.replace(/\s+/g, ' ').trim())).catch(() => [] as string[])
  return rows.find((r) => r.includes(dashed)) ?? ''
}

export async function runGhlRegistration(opts: GhlRegisterOptions): Promise<GhlRegisterResult> {
  if (opts.signal?.aborted) throw new Error('The job ran out of time.')
  claimBrowser()
  let context: BrowserContext | null = null
  let close: (() => Promise<void>) | null = null
  try {
    prepareChromiumEnv()
    const pw = (await import('playwright')) as typeof import('playwright')
    const browser = await pw.chromium.launch({ headless: opts.headless, executablePath: opts.executablePath || undefined, args: chromiumLaunchArgs() })
    close = () => browser.close()
    opts.signal?.addEventListener('abort', () => void browser.close().catch(() => {}), { once: true })
    context = await newWorkerContext(browser, opts.storageState)
    const page = await context.newPage()
    page.setDefaultTimeout(20_000)
    page.on('dialog', (d) => {
      void d.dismiss().catch(() => {})
    })
    const run: PageRun = {
      opts,
      page,
      note: async (line) => {
        await opts.onNote(line).catch(() => {})
      },
      shoot: async (step) => {
        try {
          await opts.capture(step, await capturePage(page))
        } catch {
          // A missing picture never stops the run.
        }
      },
    }
    const shown = displayNumber(opts.number)
    try {
      await openPhoneSystem(run)
      const row = await numberRow(page, opts.number)
      if (!row) throw new Halt('needs_human', `${shown} isn't in ${opts.clientName}'s GHL numbers any more.`)
      if (!/Verification Required/i.test(row)) {
        return { status: 'already', detail: `GHL no longer shows "Verification Required" for ${shown} (${row.replace(/^\+?[\d\s()-]+/, '').trim()}).`, storageState: await sessionOf(context) }
      }
      const dashed = shown.replace(/[()]/g, '').replace(' ', '-')
      const badge = page.locator('tr').filter({ hasText: dashed }).getByText('Verification Required').first()
      await badge.click({ timeout: 8000 })
      if (!(await waitVisible(page.locator('.hr-modal').filter({ hasText: /Toll-Free Verification/ }), 15_000, opts.signal))) {
        throw new Halt('needs_human', `GHL's toll-free form for ${shown} didn't open.`)
      }
      await sleep(1500, opts.signal)
      await fillStep(run, opts.form.step1, 1)
      await run.shoot('toll-free form step 1 filled')
      await nextStep(run, 1, opts.form.step2[0]?.label)
      await fillStep(run, opts.form.step2, 2)
      await run.shoot('toll-free form step 2 filled')
      await nextStep(run, 2, opts.form.step3[0]?.label)
      await fillStep(run, opts.form.step3, 3)
      await run.shoot('toll-free form step 3 filled')
      // Step 3 may end on the send button itself, or go on to a review page first.
      for (let i = 0; i < 2 && !(await visibleIn(page.locator('.hr-modal button').filter({ hasText: SEND_BUTTON }))); i++) await nextStep(run, 3 + i)
      const send = await visibleIn(page.locator('.hr-modal button').filter({ hasText: SEND_BUTTON }))
      if (!send) throw new Halt('needs_human', `GHL's toll-free form never showed "Send Information for Verification". Nothing was sent.`)
      const agree = page.locator('.hr-modal').locator('.hr-checkbox').filter({ hasText: /Terms of Service/i }).first()
      if ((await agree.count()) && !/checked/.test((await agree.getAttribute('class')) ?? '')) await agree.click({ timeout: 5000 })
      await run.shoot('toll-free form ready to send')
      if (!opts.submit) {
        await closeForm(page)
        return { status: 'review', detail: `Filled GHL's toll-free form for ${shown} and stopped before "Send Information for Verification".`, storageState: await sessionOf(context) }
      }
      if (!(await send.isEnabled().catch(() => false))) throw new Halt('needs_human', `"Send Information for Verification" stayed disabled after filling the form. Nothing was sent.`)
      await send.click({ timeout: 8000 })
      const deadline = Date.now() + 60_000
      for (;;) {
        await sleep(1500, opts.signal)
        if (await identityCheckShowing(page)) {
          await run.shoot('identity check at send')
          throw new Halt('needs_human', `GHL asked for its identity check when sending ${shown}'s registration. Finish it in GHL, then send it again from the Office.`)
        }
        if (!(await visibleIn(page.locator('.hr-modal').filter({ hasText: /Toll-Free Verification/ })))) break
        if (Date.now() >= deadline) {
          const st = await formState(page)
          await run.shoot('toll-free send stuck')
          throw new Halt('needs_human', `GHL kept the toll-free form open after "Send"${st.errors.length ? `: ${st.errors.join('; ')}` : ''}. Check ${shown} in GHL.`)
        }
      }
      await openPhoneSystem(run)
      const after = await numberRow(page, opts.number)
      if (/Verification Required/i.test(after)) {
        await run.shoot('still verification required')
        throw new Halt('needs_human', `Sent ${shown}'s registration, but GHL still shows "Verification Required". Check it in GHL.`)
      }
      return { status: 'submitted', detail: `Sent ${shown}'s toll-free registration in GHL (${after.replace(/^\+?[\d\s()-]+/, '').trim() || 'submitted'}). GHL says reviews can take up to 4–6 weeks.`, storageState: await sessionOf(context) }
    } catch (err) {
      if (opts.signal?.aborted) throw err
      await run.shoot('registration failure')
      await closeForm(page).catch(() => {})
      if (err instanceof Halt) return { status: err.status === 'needs_identity' ? 'needs_human' : err.status, detail: err.message, storageState: await sessionOf(context) }
      throw err
    }
  } finally {
    await context?.close().catch(() => {})
    await close?.().catch(() => {})
    releaseBrowser()
  }
}
