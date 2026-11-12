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
