/**
 * Find the snapshot card for an exact title. Runs inside the GHL page
 * (Playwright sends this function to the frame) and in unit tests.
 *
 * The title is its own text, next to an initials avatar ("MT"). The
 * Select & Continue control is not in the DOM until the card is hovered,
 * so this returns the card, not that button.
 */
export function locateSnapshotCard(name: string, scope?: ParentNode): Element | null {
  const root =
    scope ||
    (typeof document !== 'undefined' ? document.querySelector('[role="dialog"], [aria-modal="true"]') || document.body : null)
  if (!root) return null
  const want = name.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!want) return null

  const ownText = (el: Element) => {
    let raw = ''
    for (let i = 0; i < el.childNodes.length; i++) {
      const node = el.childNodes[i]
      if (node && node.nodeType === 3) raw += node.textContent || ''
    }
    return raw.replace(/\s+/g, ' ').trim().toLowerCase()
  }

  const elements: Element[] = []
  const collect = (parent: ParentNode) => {
    const list = parent.querySelectorAll ? Array.from(parent.querySelectorAll('*')) : []
    for (const el of list) {
      elements.push(el)
      const shadow = (el as HTMLElement).shadowRoot
      if (shadow) collect(shadow)
    }
  }
  collect(root)

  let title: Element | null = null
  let smallest = Infinity
  for (const el of elements) {
    if (ownText(el) !== want) continue
    const size = el.querySelectorAll ? el.querySelectorAll('*').length : 0
    if (size < smallest) {
      title = el
      smallest = size
    }
  }
  if (!title) return null

  const clickable = (el: Element) => {
    const tag = (el.tagName || '').toUpperCase()
    const role = (el.getAttribute('role') || '').toLowerCase()
    if (tag === 'A' || tag === 'BUTTON' || role === 'button') return true
    const cls = el.getAttribute('class') || ''
    if (/cursor-pointer|cursor:\s*pointer/i.test(cls)) return true
    try {
      if (typeof getComputedStyle === 'function' && getComputedStyle(el).cursor === 'pointer') return true
    } catch {
      // A test double has no layout.
    }
    return false
  }

  const hasAvatar = (el: Element) => {
    const nodes = el.querySelectorAll ? Array.from(el.querySelectorAll('*')) : []
    for (const node of nodes) {
      if (node === title || title.contains(node)) continue
      const text = ownText(node)
      if (/^[a-z]{1,3}$/.test(text)) return true
    }
    return false
  }

  let avatarHost: Element | null = null
  let el: Element | null = title.parentElement
  while (el) {
    if (clickable(el)) return el
    if (!avatarHost && hasAvatar(el)) avatarHost = el
    el = el.parentElement
  }
  return avatarHost || title.parentElement || title
}

export function redactCardHtml(html: string): string {
  return html.replace(/\b\d{4,8}\b/g, (digits) => '•'.repeat(digits.length)).slice(0, 1500)
}

/** Order of clicks on the business-search "Add manually" control. */
export const ADD_MANUALLY_ATTEMPTS = ['innermost click', 'clickable ancestor', 'mouse centre'] as const

export type AddManuallyAttempt = {
  name: (typeof ADD_MANUALLY_ATTEMPTS)[number]
  run: () => Promise<void>
}

/**
 * Try each Add manually click, logging every attempt. `opened` is how the
 * caller decides the details form, a dialog, or a new URL appeared.
 * On give-up, `capture` runs before the error is rethrown.
 */
export async function runSearchAddManually(opts: {
  attempts: AddManuallyAttempt[]
  opened: () => Promise<boolean>
  log: (line: string) => Promise<void> | void
  capture: (step: string) => Promise<void> | void
}): Promise<string> {
  const tried: string[] = []
  for (const attempt of opts.attempts) {
    await opts.log(`Add manually try: ${attempt.name}`)
    try {
      await attempt.run()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await opts.log(`Add manually try error: ${attempt.name}: ${message}`)
    }
    tried.push(attempt.name)
    if (await opts.opened()) {
      await opts.log(`Add manually opened via ${attempt.name}`)
      return attempt.name
    }
    await opts.log(`Add manually try failed: ${attempt.name}`)
  }
  const failure = `Add manually did not open a details form, dialog, or new page. Tried ${tried.join(', ')}.`
  await opts.capture('failure:add-manually')
  throw new Error(failure)
}

/** Innermost element whose own text says "add manually". */
export function locateAddManually(scope?: unknown): Element | null {
  const given = scope && typeof (scope as ParentNode).querySelectorAll === 'function' ? (scope as ParentNode) : null
  const root = given || (typeof document !== 'undefined' ? document.body : null)
  if (!root || !root.querySelectorAll) return null
  const re = /add manually/i
  const ownText = (el: Element) => {
    let raw = ''
    for (let i = 0; i < el.childNodes.length; i++) {
      const node = el.childNodes[i]
      if (node && node.nodeType === 3) raw += node.textContent || ''
    }
    return raw.replace(/\s+/g, ' ').trim()
  }
  let best: Element | null = null
  let smallest = Infinity
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (!re.test(ownText(el))) continue
    const size = el.querySelectorAll('*').length
    if (size < smallest) {
      best = el
      smallest = size
    }
  }
  return best
}
