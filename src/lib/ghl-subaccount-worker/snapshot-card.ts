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

/**
 * These functions are sent to the GHL page as source (`toString`).
 * Each one keeps its helpers inside so the page does not need this module.
 */

/** Prefer the card whose attributes contain the snapshot id. Falls back to the exact title. */
export function locateSnapshotCardById(target: { name: string; id: string }, scope?: ParentNode): Element | null {
  const attrBlob = (el: Element) => {
    const names = ['id', 'data-id', 'data-snapshot-id', 'data-snapshotid', 'href', 'data-value']
    const bits: string[] = []
    for (const name of names) {
      const value = el.getAttribute ? el.getAttribute(name) : null
      if (value) bits.push(value)
    }
    return bits.join(' ')
  }
  const root =
    scope ||
    (typeof document !== 'undefined' ? document.querySelector('[role="dialog"], [aria-modal="true"]') || document.body : null)
  if (!root || !target.id) return null
  const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : []
  let host: Element | null = null
  let smallest = Infinity
  for (const el of nodes) {
    if (!attrBlob(el).includes(target.id)) continue
    const size = el.querySelectorAll ? el.querySelectorAll('*').length : 0
    if (size < smallest) {
      host = el
      smallest = size
    }
  }
  if (!host) return null
  let el: Element | null = host
  while (el) {
    const tag = (el.tagName || '').toUpperCase()
    const role = (el.getAttribute && el.getAttribute('role')) || ''
    const cls = (el.getAttribute && el.getAttribute('class')) || ''
    if (tag === 'A' || tag === 'BUTTON' || role === 'button' || /cursor-pointer/i.test(cls)) return el
    el = el.parentElement
  }
  return host
}

/** Cards that expose a snapshot id on themselves or their parent. */
export function listSnapshotCardRefs(scope?: ParentNode): { name: string; id: string }[] {
  const attrBlob = (el: Element) => {
    const names = ['id', 'data-id', 'data-snapshot-id', 'data-snapshotid', 'href', 'data-value']
    const bits: string[] = []
    for (const name of names) {
      const value = el.getAttribute ? el.getAttribute(name) : null
      if (value) bits.push(value)
    }
    return bits.join(' ')
  }
  const root = scope || (typeof document !== 'undefined' ? document.body : null)
  if (!root || !root.querySelectorAll) return []
  const out: { name: string; id: string }[] = []
  const seen = new Set<string>()
  for (const el of Array.from(root.querySelectorAll('*'))) {
    let raw = ''
    for (let i = 0; i < el.childNodes.length; i++) {
      const node = el.childNodes[i]
      if (node && node.nodeType === 3) raw += node.textContent || ''
    }
    const name = raw.replace(/\s+/g, ' ').trim()
    if (name.length < 3 || name.length > 80) continue
    const blob = `${attrBlob(el)} ${el.parentElement ? attrBlob(el.parentElement) : ''}`
    const ids = blob.match(/[A-Za-z0-9_-]{16,32}/g) || []
    for (const id of ids) {
      if (id === name || seen.has(id)) continue
      seen.add(id)
      out.push({ name, id })
    }
  }
  return out
}

/** Visible button, menu, tab, and option labels. Logged when a control cannot be found. */
export function visibleControlLabels(scope?: ParentNode): string[] {
  const root = scope || (typeof document !== 'undefined' ? document.body : null)
  if (!root || !root.querySelectorAll) return []
  const out: string[] = []
  const seen = new Set<string>()
  const nodes = Array.from(root.querySelectorAll('button, a, [role="button"], [role="tab"], [role="menuitem"], [role="option"]'))
  for (const el of nodes) {
    const text = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || (el.textContent || '')
    const label = text.replace(/\s+/g, ' ').trim()
    const key = label.toLowerCase()
    if (!label || label.length > 120 || seen.has(key)) continue
    seen.add(key)
    out.push(label)
  }
  return out
}

/** Button, tab, and menu labels to log when a control is missing. */
export function visibleControls(labels: string[], limit = 40): string {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of labels) {
    const text = raw.replace(/\s+/g, ' ').trim()
    const key = text.toLowerCase()
    if (!text || seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length >= limit) break
  }
  return out.join(' | ') || '(none)'
}
