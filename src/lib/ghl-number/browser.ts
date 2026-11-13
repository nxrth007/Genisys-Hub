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

function signedInPage(snap: PageSnap): boolean {
  try {
    const u = new URL(snap.url)
    return /(gohighlevel|leadconnectorhq)\.com$/i.test(u.hostname) && /^\/(v2\/location\/|location\/|agency_dashboard|sub-accounts|settings\/|agency\/|accounts)/i.test(u.pathname)
  } catch {
    return false
  }
}

/** Open the sub-account's Phone System → Manage Numbers, signing in first if GHL asks. */
async function openPhoneSystem(run: Run): Promise<void> {
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
