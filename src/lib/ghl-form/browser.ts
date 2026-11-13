/**
 * Playwright side of making the snapshot's site form a client's own
 * (./plan.ts says what and why):
 *   1. Settings → Custom Fields: the consent checkbox field's options get the
 *      client's business name instead of A Plus Fence & Construction.
 *   2. Sites → Forms → "A Plus Fence & Construction Forms": the form's id, and
 *      its public page, which shows what a lead sees.
 *   3. Only for a sub-account made before snapshot v2: the A Plus logo and the
 *      two "Script Added!" blocks (A Plus's privacy policy and terms links) are
 *      deleted in the form builder, and the form is saved.
 *   4. The public form is read again: done only when it names the client and
 *      shows none of A Plus's logo, name or links.
 *
 * Nothing is saved when a step doesn't check out: the builder is closed
 * without saving, and the job says what stopped it. Tests never import this.
 */
import type { BrowserContext, Frame, Locator, Page } from 'playwright'
import { capturePage, claimBrowser, newWorkerContext, releaseBrowser, signInOnPage } from '@/lib/ghl-subaccount-worker/browser'
import { chromiumLaunchArgs, prepareChromiumEnv } from '@/lib/ghl-subaccount-worker/chromium-host'
import type { GhlLabels } from '@/lib/ghl-subaccount-worker/labels'
import type { PageSnap } from '@/lib/ghl-subaccount-worker/plan'
import { builderWork, formProblems, isConsentOption, isTemplateLink, publicFormUrl, renamedOptions, TEMPLATE_FORM, TEMPLATE_LOGO, TEMPLATE_SITE, type PublicForm } from './plan'

export type FormFixOptions = {
  clientName: string
  locationId: string
  /** What the consent text calls the client (plan.ts consentName). */
  businessName: string
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
  onFormId?: (formId: string) => Promise<void>
}

export type FormFixResult = {
  /** done: the public form is the client's. needs_human: stopped with nothing half-saved. error: try again. */
  status: 'done' | 'needs_human' | 'error'
  detail: string
  formId: string | null
  storageState: string | null
}

const APP = 'https://app.gohighlevel.com'
const fieldsUrl = (locationId: string) => `${APP}/v2/location/${locationId}/settings/fields?tab=field&query=checkbox`
const formsUrl = (locationId: string) => `${APP}/v2/location/${locationId}/form-builder/main`

class Halt extends Error {
  constructor(
    readonly status: 'needs_human' | 'error',
    message: string,
    /** GHL wouldn't sign in: nothing else in this run can work either. */
    readonly signIn = false,
  ) {
    super(message)
  }
}

type Run = { opts: FormFixOptions; page: Page; note: (line: string) => Promise<void>; shoot: (step: string) => Promise<void> }

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

async function sessionOf(context: BrowserContext): Promise<string | null> {
  try {
    return JSON.stringify(await context.storageState())
  } catch {
    return null
  }
}

function signedInPage(snap: PageSnap): boolean {
  try {
    const u = new URL(snap.url)
    return /(gohighlevel|leadconnectorhq)\.com$/i.test(u.hostname) && /^\/(v2\/location\/|location\/|agency_dashboard|sub-accounts|settings\/|agency\/|accounts)/i.test(u.pathname)
  } catch {
    return false
  }
}

const bodyText = (frame: Page | Frame) => frame.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ')).catch(() => '')

/** Open one of the sub-account's pages, signing in first if GHL asks; `ready` says when it has loaded. */
async function openLocationPage(run: Run, url: string, what: string, ready: () => Promise<boolean>): Promise<void> {
  const { page, opts } = run
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    const deadline = Date.now() + 60_000
    let login = false
    for (;;) {
      if (await visibleIn(page.locator('input[type="password"]'))) {
        login = true
        break
      }
      if (await ready()) return
      if (Date.now() >= deadline) break
      await sleep(700, opts.signal)
    }
    if (!login) throw new Halt('error', `GHL's ${what} didn't load.`)
    await run.note('GHL asked to sign in. Signing in with the agency login.')
    const res = await signInOnPage(page, {
      label: `${opts.clientName}'s site form`,
      homeUrl: url,
      labels: opts.labels,
      login: opts.login,
      pullOtp: opts.pullOtp,
      onOtpPrompt: opts.onOtpPrompt,
      onNote: run.note,
      capture: opts.capture,
      isSignedIn: signedInPage,
      signal: opts.signal,
    })
    if (res.status !== 'signed_in') throw new Halt(res.status === 'failed' ? 'error' : 'needs_human', res.detail, true)
  }
  throw new Halt('error', `GHL's ${what} didn't load after signing in.`)
}

/** Press a confirmation GHL may show after "Update field" (the change is the point); never one that deletes. */
async function answerConfirm(page: Page, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const modal = await visibleIn(page.locator('.hr-modal, [role="dialog"]').filter({ hasNotText: /Update field/ }))
    if (modal) {
      const text = ((await modal.innerText().catch(() => '')) || '').replace(/\s+/g, ' ')
      if (/delete|remove/i.test(text)) throw new Halt('needs_human', `GHL asked something unexpected after "Update field": "${text.slice(0, 160)}". Nothing was confirmed.`)
      const yes = await visibleIn(modal.locator('button').filter({ hasText: /^\s*(Confirm|Yes|Update|Continue|Proceed|Save|OK)\b/i }))
      if (yes) {
        await yes.click({ timeout: 5000 })
        return
      }
    }
    await sleep(400, signal)
  }
}

/**
 * Step 1: the consent checkbox field's options name the client. renamed: this
 * run put the name in; already: no option names A Plus any more; missing: the
 * sub-account has no consent checkbox field (it never got the snapshot's form).
 */
async function fixConsent(run: Run): Promise<'renamed' | 'already' | 'missing'> {
  const { page, opts } = run
  await openLocationPage(run, fieldsUrl(opts.locationId), 'Custom Fields page', async () => {
    const text = await bodyText(page)
    if (!/Custom fields/i.test(text)) return false
    return (await page.locator('tr').count().catch(() => 0)) > 1 || /No (data|fields|results)/i.test(text)
  })
  // The table draws its rows a moment after the page (seen 2026-11-13: the first run looked too early).
  // A row's text runs its cells together ("aCheckboxForm | Form 0…"), so look for the word inside it.
  const rows = page.locator('tr').filter({ hasText: 'Checkbox' })
  const listed = Date.now() + 20_000
  while (!(await rows.count().catch(() => 0)) && Date.now() < listed) await sleep(700, opts.signal)
  await sleep(800, opts.signal)
  const n = Math.min(await rows.count().catch(() => 0), 8)
  if (!n) return 'missing'
  let changed = false
  let found = false
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i)
    // The row's first action is the pencil (then move to folder, then delete).
    const actions = row.locator('td').last()
    let pencil = actions.locator('button, [role="button"]').first()
    if (!(await pencil.count().catch(() => 0))) pencil = actions.locator('svg').first()
    if (!(await pencil.count().catch(() => 0))) {
      await run.shoot('no pencil on checkbox field')
      throw new Halt('needs_human', `Couldn't find the edit pencil on a checkbox field in ${opts.clientName}'s Custom Fields. Nothing was changed.`)
    }
    await pencil.click({ timeout: 8000 })
    const drawer = await waitVisible(page.locator('.hr-drawer').filter({ hasText: /Update field/ }), 10_000, opts.signal)
    if (!drawer) {
      await page.keyboard.press('Escape').catch(() => {})
      await run.shoot('no update field drawer')
      throw new Halt('needs_human', `The pencil on a checkbox field in ${opts.clientName}'s Custom Fields didn't open "Update field". Nothing was changed.`)
    }
    const inputs = drawer.locator('input[placeholder="Enter option"]')
    const read = () => inputs.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))
    const values = await read()
    const cancel = async () => {
      const button = await visibleIn(drawer.locator('button').filter({ hasText: /^\s*Cancel\s*$/ }))
      if (button) await button.click({ timeout: 5000 }).catch(() => {})
      await sleep(600, opts.signal)
    }
    if (!values.some(isConsentOption)) {
      await cancel()
      continue
    }
    found = true
    const next = renamedOptions(values, opts.businessName)
    if (!next) {
      await cancel()
      continue
    }
    for (let k = 0; k < values.length; k++) {
      if (next[k] === values[k]) continue
      const box = inputs.nth(k)
      await box.click({ timeout: 5000 })
      await box.fill(next[k])
    }
    if ((await read()).join('\n') !== next.join('\n')) {
      await cancel()
      throw new Halt('needs_human', `GHL's option boxes didn't take ${opts.clientName}'s name. Nothing was saved.`)
    }
    await run.shoot('consent options renamed')
    const update = drawer.locator('button').filter({ hasText: /^\s*Update field\s*$/ }).first()
    if (!(await update.isEnabled().catch(() => false))) {
      await cancel()
      throw new Halt('needs_human', `GHL's "Update field" stayed disabled after renaming the consent options. Nothing was saved.`)
    }
    await update.click({ timeout: 8000 })
    await answerConfirm(page, opts.signal)
    const deadline = Date.now() + 20_000
    while (await drawer.isVisible().catch(() => false)) {
      if (Date.now() >= deadline) {
        await run.shoot('update field stuck')
        throw new Halt('needs_human', `GHL kept the "Update field" drawer open after saving ${opts.clientName}'s consent options.`)
      }
      await sleep(500, opts.signal)
    }
    await run.note(`Renamed the consent checkboxes for ${opts.businessName}.`)
    changed = true
  }
  if (!found) return 'missing'
  return changed ? 'renamed' : 'already'
}

class NoTemplateForm extends Error {}

/** Step 2: open the template form from the Forms list (it may sit in an embedded app). Returns its id. */
async function openTemplateForm(run: Run): Promise<string> {
  const { page, opts } = run
  const find = async (): Promise<Locator | null> => {
    for (const frame of page.frames()) {
      const hit = await visibleIn(frame.getByText(TEMPLATE_FORM, { exact: true }))
      if (hit) return hit
    }
    return null
  }
  const found: { link: Locator | null } = { link: null }
  await openLocationPage(run, formsUrl(opts.locationId), 'Forms list', async () => {
    found.link = await find()
    return !!found.link
  }).catch(async (err) => {
    if (err instanceof Halt && !err.signIn) {
      await run.shoot('no template form')
      throw new NoTemplateForm(`${opts.clientName}'s Forms have no "${TEMPLATE_FORM}" (renamed or deleted?).`)
    }
    throw err
  })
  if (!found.link) throw new Halt('error', `"${TEMPLATE_FORM}" went missing from the Forms list.`)
  await found.link.click({ timeout: 8000 })
  const deadline = Date.now() + 30_000
  for (;;) {
    const id = /\/form-builder-v2\/([A-Za-z0-9]+)/.exec(page.url())?.[1]
    if (id) return id
    if (Date.now() >= deadline) throw new Halt('error', `Opening "${TEMPLATE_FORM}" didn't open GHL's form builder.`)
    await sleep(500, opts.signal)
  }
}

/** What a lead sees on the public form, read in its own page (no sign-in). Waits for it to show its consent text. */
async function readPublicForm(context: BrowserContext, formId: string, signal?: AbortSignal): Promise<PublicForm> {
  const p = await context.newPage()
  try {
    await p.goto(publicFormUrl(formId), { waitUntil: 'domcontentloaded', timeout: 60_000 })
    const deadline = Date.now() + 30_000
    for (;;) {
      const text = await bodyText(p)
      if (isConsentOption(text) || Date.now() >= deadline) break
      await sleep(700, signal)
    }
    // The logo loads late and the policy links come from the form's scripts: let it settle.
    await p.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
    await sleep(2500, signal)
    return await p.evaluate(() => ({
      text: (document.body?.innerText || '').replace(/\s+/g, ' '),
      images: Array.from(document.images).map((i) => i.currentSrc || i.src),
      links: Array.from(document.querySelectorAll('a')).map((a) => (a as HTMLAnchorElement).href),
    }))
  } finally {
    await p.close().catch(() => {})
  }
}

/** The form builder's frame (an embedded app), once it shows the form. */
async function builderFrame(run: Run): Promise<Frame> {
  const { page, opts } = run
  const deadline = Date.now() + 60_000
  for (;;) {
    for (const frame of page.frames()) {
      if (!/form-survey-builder/i.test(frame.url())) continue
      if (isConsentOption(await bodyText(frame))) return frame
    }
    if (Date.now() >= deadline) throw new Halt('error', "GHL's form builder didn't load the form.")
    await sleep(800, opts.signal)
  }
}

/** Small icon boxes on screen in the builder, by position (the selected block's toolbar shows up as new ones). */
const iconKeys = (frame: Frame) =>
  frame
    .evaluate(() =>
      Array.from(document.querySelectorAll('svg'))
        .map((s) => (s.closest('button, [role="button"]') || s.parentElement || s).getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0 && r.width < 48 && r.height < 48)
        .map((r) => `${Math.round(r.x)}:${Math.round(r.y)}`),
    )
    .catch(() => [] as string[])

/**
 * Delete one block: select it, then press the trash icon, the last of the
 * three icons (settings, duplicate, delete) that appear in a row at the top of
 * a selected block. Checks the block is gone; otherwise stops before any save.
 */
async function deleteBlock(run: Run, frame: Frame, select: () => Promise<void>, count: () => Promise<number>, what: string): Promise<void> {
  const before = await count()
  if (!before) return
  const prior = await iconKeys(frame)
  await select()
  await sleep(800, run.opts.signal)
  const row = await frame
    .evaluate((prev: string[]) => {
      const seen = new Set(prev)
      const items = Array.from(document.querySelectorAll('svg'))
        .map((s) => {
          const el = (s.closest('button, [role="button"]') || s.parentElement || s) as HTMLElement
          const r = el.getBoundingClientRect()
          return { el, r, key: `${Math.round(r.x)}:${Math.round(r.y)}` }
        })
        .filter((x) => x.r.width > 0 && x.r.height > 0 && x.r.width < 48 && x.r.height < 48 && !seen.has(x.key))
      if (items.length < 2) return 0
      const top = Math.min(...items.map((x) => x.r.y))
      const line = items.filter((x) => Math.abs(x.r.y - top) < 8)
      if (line.length < 2) return 0
      const trash = line.reduce((a, b) => (b.r.x > a.r.x ? b : a))
      document.querySelectorAll('[data-hubdel]').forEach((e) => e.removeAttribute('data-hubdel'))
      trash.el.setAttribute('data-hubdel', '1')
      return line.length
    }, prior)
    .catch(() => 0)
  if (!row) {
    await run.shoot(`no toolbar on ${what}`)
    throw new Halt('needs_human', `Selecting the ${what} in GHL's form builder showed no toolbar to delete it. Nothing was saved.`)
  }
  await frame.locator('[data-hubdel="1"]').first().click({ timeout: 5000 })
  await sleep(900, run.opts.signal)
  const after = await count()
  if (after !== before - 1) {
    await run.shoot(`${what} not deleted`)
    throw new Halt('needs_human', `Deleting the ${what} in GHL's form builder didn't work (${before} before, ${after} after). Nothing was saved.`)
  }
}

/**
 * Step 3 (sub-accounts made before snapshot v2): delete A Plus's logo and
 * policy-link blocks, then save. `seen` (the public form) says what's A
 * Plus's: a client's own logo or policy links on a form fixed by hand stay.
 * Returns whether it changed anything; nothing to remove means no save.
 */
async function cleanBuilder(run: Run, seen: PublicForm): Promise<boolean> {
  const work = builderWork(seen)
  if (!work.logo && !work.links) return false
  const aplusLinks = seen.links.filter(isTemplateLink).length
  const { page, opts } = run
  const frame = await builderFrame(run)
  await sleep(1500, opts.signal)
  // The builder opens with its "Form Element" panel over the left of the form: close it (its header's ×).
  const closed = await frame
    .evaluate(() => {
      const title = Array.from(document.querySelectorAll('*')).find((e) => (e as HTMLElement).innerText?.trim() === 'Form Element' && e.getBoundingClientRect().height > 0)
      const header = title?.parentElement
      const icons = header ? Array.from(header.querySelectorAll('svg')) : []
      const x = icons.length ? ((icons[icons.length - 1].closest('button, [role="button"]') || icons[icons.length - 1].parentElement) as HTMLElement | null) : null
      if (!x) return false
      x.setAttribute('data-hubclose', '1')
      return true
    })
    .catch(() => false)
  if (closed) {
    await frame.locator('[data-hubclose="1"]').first().click({ timeout: 4000 }).catch(() => {})
    await sleep(800, opts.signal)
  }
  // Only A Plus's own logo (by its file) and policy blocks.
  const logoImgs = frame.locator(`img[src*="${TEMPLATE_LOGO}"]`)
  const policyLinks = frame.locator(`a[href*="${TEMPLATE_SITE}"]`)
  const labels = frame.getByText('Script Added!', { exact: true })
  const logos = () => logoImgs.count().catch(() => 0)
  // The logo's picture and the blocks' links can arrive a few seconds after the form.
  const seenBy = Date.now() + 8000
  while ((work.logo && !(await logos())) || (work.links && !(await policyLinks.count().catch(() => 0)) && !(await labels.count().catch(() => 0)))) {
    if (Date.now() >= seenBy) break
    await sleep(700, opts.signal)
  }
  // A policy block is found by its A Plus link when the builder draws it; otherwise by its "Script Added!"
  // label, but only when every such block is A Plus's (as many as the public form's A Plus links).
  const byLink = (await policyLinks.count().catch(() => 0)) > 0
  const scriptLabels = await labels.count().catch(() => 0)
  if (work.links && !byLink && scriptLabels !== aplusLinks) {
    await run.shoot('policy blocks unclear')
    throw new Halt('needs_human', `The form has ${scriptLabels} code block(s) but ${aplusLinks} A Plus policy link(s), so the worker can't tell which blocks are A Plus's. Remove A Plus's Privacy Policy and Terms blocks by hand. Nothing was saved.`)
  }
  const policy = byLink ? policyLinks : labels
  const scripts = () => policy.count().catch(() => 0)
  // Blocks are clicked across the form's middle: the heading gives its centre.
  const heading = await visibleIn(frame.getByText('Get Your Free Estimate'))
  const middle = heading ? await heading.boundingBox() : null
  const clickRow = async (target: Locator) => {
    // The policy blocks sit at the bottom of the form: bring the row into view before clicking its middle.
    await target.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
    await sleep(400, opts.signal)
    const box = await target.boundingBox()
    if (!box) throw new Halt('needs_human', 'A block in GHL\'s form builder had no position to click. Nothing was saved.')
    await page.mouse.click(middle ? middle.x + middle.width / 2 : box.x + box.width / 2, box.y + box.height / 2)
  }
  if (work.logo) {
    await deleteBlock(run, frame, async () => {
      const img = await visibleIn(logoImgs)
      if (!img) throw new Halt('needs_human', "The A Plus logo wasn't on screen in GHL's form builder. Nothing was saved.")
      await img.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
      await img.click({ timeout: 5000 })
    }, logos, 'A Plus logo')
    await run.note('Deleted the A Plus logo from the form.')
  }
  if (work.links) {
    for (let i = 0; i < Math.max(aplusLinks, 1) && (await scripts()); i++) {
      await deleteBlock(run, frame, async () => {
        const block = await visibleIn(policy)
        if (!block) throw new Halt('needs_human', 'An A Plus policy-link block wasn\'t on screen. Nothing was saved.')
        await clickRow(block)
      }, scripts, 'A Plus policy-link block')
    }
    if (byLink && (await scripts())) throw new Halt('needs_human', 'An A Plus policy link is still in the form after deleting its blocks. Nothing was saved.')
    await run.note("Deleted the two A Plus policy-link blocks (Privacy Policy, Terms) from the form.")
  }
  await run.shoot('form builder cleaned')
  const save = await visibleIn(frame.locator('button').filter({ hasText: /^\s*Save\s*$/ }))
  if (!save) throw new Halt('needs_human', "GHL's form builder had no Save button. Nothing was saved.")
  await save.click({ timeout: 8000 })
  const deadline = Date.now() + 30_000
  await sleep(1500, opts.signal)
  while (await visibleIn(frame.locator('button').filter({ hasText: /Saving/ }))) {
    if (Date.now() >= deadline) throw new Halt('needs_human', "GHL's form builder kept saving for 30 seconds. Check the form in GHL.")
    await sleep(700, opts.signal)
  }
  await run.note('Saved the form.')
  return true
}

export async function runFormFix(opts: FormFixOptions): Promise<FormFixResult> {
  if (opts.signal?.aborted) throw new Error('The job ran out of time.')
  claimBrowser()
  let context: BrowserContext | null = null
  let close: (() => Promise<void>) | null = null
  let formId: string | null = null
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
    try {
      const consent = await fixConsent(run)
      const renamed = consent === 'renamed'
      try {
        formId = await openTemplateForm(run)
      } catch (err) {
        if (!(err instanceof NoTemplateForm)) throw err
        const quiet = (detail: string) => ({ status: 'done' as const, detail, formId: null, storageState: null as string | null })
        // Never had the snapshot's form (an older sub-account): nothing to change.
        if (consent === 'missing') return { ...quiet(`${opts.clientName}'s sub-account doesn't have the snapshot's site form or its consent checkboxes, so there was nothing to change.`), storageState: await sessionOf(context) }
        // Renamed when someone made it theirs by hand, with the consent already naming the client: leave it.
        if (consent === 'already') return { ...quiet(`${opts.clientName}'s form was already made theirs by hand: the consent checkboxes don't name A Plus, and the form isn't called "${TEMPLATE_FORM}" any more.`), storageState: await sessionOf(context) }
        throw new Halt('needs_human', `${err.message} The consent checkboxes now name ${opts.businessName}; check the form itself in GHL.`)
      }
      if (consent === 'missing') {
        throw new Halt('needs_human', `${opts.clientName} has "${TEMPLATE_FORM}" but no consent checkbox field with its text in Custom Fields. Check the form's consent checkboxes in GHL.`)
      }
      await opts.onFormId?.(formId)
      // The public form says what's still A Plus's (the builder, open now, removes it).
      let seen = await readPublicForm(context, formId, opts.signal)
      let cleaned = await cleanBuilder(run, seen)
      // GHL may take a moment to show the changes on the public form.
      if (cleaned) seen = await readPublicForm(context, formId, opts.signal)
      // Whose name the consent gives is only checked when this run put it there.
      const expect = renamed ? opts.businessName : ''
      for (let i = 0; i < 4 && formProblems(seen, expect).length; i++) {
        await sleep(15_000, opts.signal)
        seen = await readPublicForm(context, formId, opts.signal)
        // A first read that came too early (the logo and links load late) gets one more clean-up.
        const left = builderWork(seen)
        if (!cleaned && (left.logo || left.links)) cleaned = await cleanBuilder(run, seen)
      }
      const problems = formProblems(seen, expect)
      if (problems.length) {
        throw new Halt('needs_human', `The public form still isn't ${opts.clientName}'s: ${problems.join('; ')}. ${publicFormUrl(formId)}`)
      }
      const did = [renamed ? `consent names ${opts.businessName}` : 'consent already named them', cleaned ? "removed A Plus's logo and policy links" : '']
      return {
        status: 'done',
        detail: `${opts.clientName}'s site form is theirs: ${did.filter(Boolean).join(', ')}. Checked on the public form: ${publicFormUrl(formId)}`,
        formId,
        storageState: await sessionOf(context),
      }
    } catch (err) {
      if (opts.signal?.aborted) throw err
      await run.shoot('form fix stopped')
      if (err instanceof Halt) return { status: err.status, detail: err.message, formId, storageState: await sessionOf(context) }
      throw err
    }
  } finally {
    await context?.close().catch(() => {})
    await close?.().catch(() => {})
    releaseBrowser()
  }
}
