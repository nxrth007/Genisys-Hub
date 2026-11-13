/**
 * Playwright side of one number run:
 *   1. the client's sub-account already has a number → nothing to buy;
 *   2. buy one toll-free number in the bank sub-account (Lead Genisys, whose
 *      one-time GHL identity check is done), remembering which number was
 *      picked before "Proceed to Buy" so a crash never leads to a second buy;
 *   3. move exactly that number to the client with GHL's Move Numbers;
 *   4. read where its calls ring and, if it isn't the client's phone, set
 *      the number's External Phone Number to it.
 *
 * GHL's identity check (Persona) is never started: if it appears, the run
 * stops and a person does it. Screens were mapped in the in-app browser on
 * 2026-11-12 (Lead Genisys, the test sub-account and Agency → Phone
 * Integration); the step after "Proceed to Buy" in a verified sub-account
 * and the Move confirmation were not seen yet, so both are read loosely and
 * logged. Tests never import this file.
 */
import type { BrowserContext, Locator, Page } from 'playwright'
import { capturePage, claimBrowser, newWorkerContext, releaseBrowser, signInOnPage } from '@/lib/ghl-subaccount-worker/browser'
import { chromiumLaunchArgs, prepareChromiumEnv } from '@/lib/ghl-subaccount-worker/chromium-host'
import type { GhlLabels } from '@/lib/ghl-subaccount-worker/labels'
import type { PageSnap } from '@/lib/ghl-subaccount-worker/plan'
import { CONFIRM_BUY, CONFIRM_MOVE, displayNumber, e164, forwardingFrom, isIdentityCheck, MAX_TOLL_FREE_PRICE, parseBuyRow, pickTollFree } from './plan'

export type NumberJobState = { pickedNumber: string | null; buyStartedAt: Date | null; phoneNumber: string | null; movedAt: Date | null }

export type NumberBrowserOptions = {
  clientName: string
  clientLocationId: string
  /** The client's sub-account name exactly as GHL lists it (Move Numbers picks by name). */
  clientLocationName: string
  bankLocationId: string
  bankName: string
  /** The client's phone the calls should ring (E.164). */
  businessPhone: string
  state: NumberJobState
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
  onBought: (number: string) => Promise<void>
  onMoved: (number: string) => Promise<void>
}

export type NumberBrowserResult = {
  /** done: bought (or found) and in the client's sub-account. already: it had one. */
  status: 'done' | 'already' | 'rehearsed' | 'needs_human' | 'error'
  detail: string
  phoneNumber?: string
  forwardsTo?: string
  /** Stopped at GHL's identity check in the bank. */
  identityCheck?: boolean
  storageState: string | null
}

const APP = 'https://app.gohighlevel.com'

/** Dry-run mode stopped right before the purchase. */
class Rehearsed extends Error {}

class Halt extends Error {
  constructor(
    readonly status: 'needs_human' | 'error',
    message: string,
    readonly identityCheck = false,
  ) {
    super(message)
  }
}

const phoneSystemUrl = (locationId: string) => `${APP}/v2/location/${locationId}/settings/phone_system?tab=manage`
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const exactly = (s: string) => new RegExp(`^\\s*${esc(s)}\\s*$`)

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

type Run = { opts: NumberBrowserOptions; context: BrowserContext; page: Page; note: (l: string) => Promise<void>; shoot: (s: string) => Promise<void> }

function signedInPage(snap: PageSnap): boolean {
  try {
    const u = new URL(snap.url)
    return /(gohighlevel|leadconnectorhq)\.com$/i.test(u.hostname) && /^\/(v2\/location\/|location\/|agency_dashboard|sub-accounts|settings\/|agency\/|accounts)/i.test(u.pathname)
  } catch {
    return false
  }
}

/** Open a sub-account's Phone System → Manage Numbers, signing in first if GHL asks. */
async function openPhoneSystem(run: Run, locationId: string): Promise<void> {
  const { page, opts } = run
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(phoneSystemUrl(locationId), { waitUntil: 'domcontentloaded', timeout: 60_000 })
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
      homeUrl: phoneSystemUrl(locationId),
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

/** The numbers on the open Manage Numbers page (E.164 for US/Canada, the shown text otherwise). */
async function listedNumbers(page: Page): Promise<string[]> {
  const rows = await page
    .evaluate(async () => {
      const seen = new Set<string>()
      const grab = () => {
        for (const r of Array.from(document.querySelectorAll('tr'))) {
          const t = (r as HTMLElement).innerText.replace(/\s+/g, ' ').trim()
          if (/\$\d/.test(t)) continue
          const m = /\+\d[\d\s().-]{6,}\d/.exec(t)
          if (m) seen.add(m[0])
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
      return Array.from(seen)
    })
    .catch(() => [] as string[])
  return rows.map((r) => e164(r) || r.replace(/\s+/g, ' '))
}

/** Buy one toll-free number in the bank. Returns it (E.164). */
async function buyInBank(run: Run): Promise<string> {
  const { page, opts } = run
  await openPhoneSystem(run, opts.bankLocationId)
  const before = await listedNumbers(page)
  await run.note(`${opts.bankName} has ${before.length} number${before.length === 1 ? '' : 's'} before the purchase; none of them are touched.`)
  const add = await waitVisible(page.locator('button').filter({ hasText: /^\s*\+?\s*Add Number\s*$/ }), 20_000, opts.signal)
  if (!add) throw new Halt('error', `Couldn't find "Add Number" in ${opts.bankName}'s Phone System.`)
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
  await run.note(`Picked ${displayNumber(picked.number)} (${picked.text}) in ${opts.bankName}. Total $${total}/month.`)
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
        'needs_human',
        `GHL asked for its one-time identity check in ${opts.bankName} before buying. A person has to do it (ID and selfie): open ${opts.bankName} → Settings → Phone System → Add Number → Add Phone Number, pick any toll-free number, press Proceed to Buy and finish the check. Then press "Buy and move now" on the client's Toll-Free page in the Hub. Nothing was bought by the Hub.`,
        true,
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
      throw new Halt('needs_human', `Pressed Proceed to Buy for ${displayNumber(picked.number)} but GHL never finished or asked anything the Hub knows. Check ${opts.bankName}'s numbers before retrying, in case it was bought.`)
    }
  }
  // The number should now be in the bank.
  for (let i = 0; i < 6; i++) {
    await openPhoneSystem(run, opts.bankLocationId)
    if ((await listedNumbers(page)).includes(picked.number)) {
      await opts.onBought(picked.number)
      await run.note(`Bought ${displayNumber(picked.number)} in ${opts.bankName}.`)
      return picked.number
    }
    await sleep(10_000, opts.signal)
  }
  await run.shoot('bought number missing')
  throw new Halt('needs_human', `Pressed Buy for ${displayNumber(picked.number)} but it isn't in ${opts.bankName}'s numbers. Check whether it was charged before trying again.`)
}

/** Pick an option in one of the Move dialog's searchable selects by its exact name. */
async function chooseSubAccount(run: Run, select: Locator, name: string): Promise<void> {
  const { page, opts } = run
  await select.click({ timeout: 8000 })
  await sleep(500, opts.signal)
  await page.keyboard.type(name, { delay: 20 })
  await sleep(1200, opts.signal)
  const options = page.locator('.hr-base-select-option').filter({ hasText: exactly(name) })
  const first = await waitVisible(options, 10_000, opts.signal)
  if (!first) throw new Halt('needs_human', `Move Numbers has no sub-account named exactly "${name}".`)
  const names = await page.locator('.hr-base-select-option').evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim()))
  if (new Set(names.filter((n) => n === name)).size !== 1 || names.filter((n) => n === name).length > 2) {
    // The list renders each option twice; more than that means two sub-accounts share the name.
    throw new Halt('needs_human', `More than one sub-account is named "${name}", so the Hub didn't pick one in Move Numbers.`)
  }
  await first.click({ timeout: 8000 })
  await sleep(1000, opts.signal)
  const shown = ((await select.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim()
  if (shown !== name) throw new Halt('error', `Move Numbers shows "${shown}" after picking "${name}".`)
}

/** Move exactly `number` from the bank to the client with GHL's Move Numbers. */
async function moveToClient(run: Run, number: string): Promise<void> {
  const { page, opts } = run
  const shown = displayNumber(number)
  await page.goto(`${APP}/settings/phone_integration`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  const tab = await waitVisible(page.getByText('Sub Account Settings', { exact: true }), 30_000, opts.signal)
  if (!tab) throw new Halt('error', "Agency → Phone Integration didn't load.")
  await tab.click({ timeout: 8000 })
  const open = await waitVisible(page.locator('button').filter({ hasText: /^\s*Move Numbers\s*$/ }), 20_000, opts.signal)
  if (!open) throw new Halt('error', 'No "Move Numbers" button on Phone Integration → Sub Account Settings.')
  await open.click({ timeout: 8000 })
  const modal = page.locator('.hr-modal').filter({ hasText: 'Move numbers' })
  if (!(await waitVisible(modal, 15_000, opts.signal))) throw new Halt('error', 'The Move numbers dialog did not open.')
  const selects = modal.locator('.hr-select')
  await chooseSubAccount(run, selects.nth(0), opts.bankName)
  // Exactly the number this job bought; never another.
  const chip = modal.locator('div').filter({ hasText: exactly(shown) }).filter({ has: page.locator('.hr-checkbox') }).last()
  if (!(await waitVisible(chip, 20_000, opts.signal))) throw new Halt('needs_human', `${shown} isn't in ${opts.bankName}'s list in Move Numbers.`)
  await chip.locator('.hr-checkbox').first().click({ timeout: 8000 })
  await sleep(600, opts.signal)
  const checked = await modal.locator('.hr-checkbox--checked').count()
  const chipChecked = await chip.locator('.hr-checkbox--checked').count()
  if (checked !== 1 || chipChecked !== 1) {
    throw new Halt('needs_human', `Move Numbers didn't show exactly ${shown} ticked (${checked} ticked), so nothing was moved.`)
  }
  await chooseSubAccount(run, selects.nth(1), opts.clientLocationName)
  const moveBtn = modal.locator('button').filter({ hasText: /^\s*Move Numbers\s*$/ }).last()
  if (!(await moveBtn.isEnabled().catch(() => false))) throw new Halt('error', '"Move Numbers" stayed disabled after choosing the number and the client.')
  await run.note(`Moving ${shown} from ${opts.bankName} to "${opts.clientLocationName}" (${opts.clientLocationId}).`)
  await run.shoot('move ready')
  await moveBtn.click({ timeout: 8000 })
  let confirmed = false
  const deadline = Date.now() + 60_000
  for (;;) {
    await sleep(1500, opts.signal)
    if (!confirmed) {
      const others = page.locator('.hr-modal, [role="dialog"], [aria-modal="true"]').filter({ hasNotText: 'Move your numbers from one sub-account' })
      const confirm = await visibleIn(others.locator('button').filter({ hasText: CONFIRM_MOVE }))
      if (confirm && (await confirm.isEnabled().catch(() => false))) {
        await run.note(`GHL asked to confirm the move; pressing "${((await confirm.innerText().catch(() => '')) || '').trim()}".`)
        await confirm.click({ timeout: 8000 })
        confirmed = true
        continue
      }
    }
    if (!(await visibleIn(modal))) break
    if (Date.now() >= deadline) break
  }
  // Confirm it arrived.
  for (let i = 0; i < 6; i++) {
    await openPhoneSystem(run, opts.clientLocationId)
    if ((await listedNumbers(page)).includes(number)) {
      await opts.onMoved(number)
      await run.note(`${shown} is now in ${opts.clientName}'s sub-account.`)
      return
    }
    await sleep(10_000, opts.signal)
  }
  await run.shoot('move not visible')
  throw new Halt('needs_human', `Moved ${shown} but it doesn't show in ${opts.clientName}'s sub-account yet. Check Agency → Phone Integration.`)
}

/** Read where the number's calls ring; point them at the client's phone if they don't already go there. */
async function checkForwarding(run: Run, number: string): Promise<{ forwardsTo: string; note: string }> {
  const { page, opts } = run
  const want = e164(opts.businessPhone)
  const dashed = displayNumber(number).replace(/[()]/g, '').replace(' ', '-')
  const openConfig = async (): Promise<Locator> => {
    await openPhoneSystem(run, opts.clientLocationId)
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
  let routes = forwardingFrom(((await modal.innerText().catch(() => '')) || ''))
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
  routes = forwardingFrom(((await modal.innerText().catch(() => '')) || ''))
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

export async function runNumberInBrowser(opts: NumberBrowserOptions): Promise<NumberBrowserResult> {
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
      // 1. Already has a number (bought by hand, or an earlier run moved it)?
      await openPhoneSystem(run, opts.clientLocationId)
      const has = await listedNumbers(page)
      const mine = st.phoneNumber && has.includes(st.phoneNumber) ? st.phoneNumber : null
      if (has.length && !mine) {
        return { status: 'already', detail: `The sub-account already has ${has.map(displayNumber).join(', ')}, so nothing was bought.`, phoneNumber: e164(has[0]) || undefined, storageState: await sessionOf(context) }
      }
      let number = mine ?? st.phoneNumber
      if (!number && st.pickedNumber) {
        // An earlier run pressed Buy: look for that exact number before anything else.
        await openPhoneSystem(run, opts.bankLocationId)
        if ((await listedNumbers(page)).includes(st.pickedNumber)) {
          number = st.pickedNumber
          await opts.onBought(number)
          await run.note(`An earlier run bought ${displayNumber(number)}; using it.`)
        } else if (st.buyStartedAt) {
          return {
            status: 'needs_human',
            detail: `An earlier run pressed Buy for ${displayNumber(st.pickedNumber)}, and it isn't in ${opts.bankName}. Check ${opts.bankName}'s numbers and GHL billing. If it wasn't bought, press "Buy and move now" on the client's Toll-Free page to buy a new one.`,
            storageState: await sessionOf(context),
          }
        } else {
          await run.note(`An earlier run's ${displayNumber(st.pickedNumber)} isn't in ${opts.bankName}, and a person confirmed it wasn't bought. Buying a new one.`)
        }
      }
      if (!number) number = await buyInBank(run)
      if (!mine) await moveToClient(run, number)
      let forwardsTo = ''
      let fwdNote = ''
      try {
        const f = await checkForwarding(run, number)
        forwardsTo = f.forwardsTo
        fwdNote = f.note
      } catch (err) {
        if (!(err instanceof Halt)) throw err
        await run.shoot('forwarding')
        return { status: 'needs_human', detail: `${displayNumber(number)} is in ${opts.clientName}'s sub-account. ${err.message}`, phoneNumber: number, storageState: await sessionOf(context) }
      }
      return { status: 'done', detail: `${displayNumber(number)} is in ${opts.clientName}'s sub-account. ${fwdNote}`, phoneNumber: number, forwardsTo, storageState: await sessionOf(context) }
    } catch (err) {
      if (opts.signal?.aborted) throw err
      await run.shoot('failure')
      if (err instanceof Rehearsed) return { status: 'rehearsed', detail: err.message, storageState: await sessionOf(context) }
      if (err instanceof Halt) {
        return { status: err.status, detail: err.message, identityCheck: err.identityCheck, storageState: await sessionOf(context) }
      }
      throw err
    }
  } finally {
    await context?.close().catch(() => {})
    await close?.().catch(() => {})
    releaseBrowser()
  }
}
