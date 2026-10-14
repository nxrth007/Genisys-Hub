/**
 * Runs inside the signed-in GHL tab. Receives one job from background.js
 * and does what a person would: Sub-Accounts → Create Sub-Account → fill
 * the form → pick the snapshot → (mode "create") press Create. Finds
 * things by their visible words, not CSS classes, so GHL's styling changes
 * don't matter; its wording changes do, and LABELS is where to adjust
 * (also editable in the extension's options as JSON, no reinstall).
 *
 * Every step has a timeout. The first thing that can't be found stops the
 * run with a message saying what, and the overlay tells the person what's
 * left to do by hand. Nothing is ever retried inside the page.
 */
;(() => {
  if (window.__genisysGhl) return
  window.__genisysGhl = true

  const DEFAULT_LABELS = {
    // Navigation (buttons / links found by their text)
    subAccountsNav: ['Sub-Accounts', 'Sub Accounts', 'Accounts'],
    createButton: ['Create Sub-Account', 'Create Sub Account', 'Add Sub-Account', 'Create Account', 'Add Account'],
    addBusiness: ['Add a new business', 'Add new business', 'New business'],
    // Form fields (matched against <label>, placeholder, name, aria-label)
    name: ['Business Name', 'Account Name', 'Location Name', 'Name'],
    email: ['Business Email', 'Email'],
    phone: ['Business Phone', 'Phone'],
    address: ['Address', 'Street', 'Business Address'],
    city: ['City'],
    state: ['State', 'Province'],
    postalCode: ['Postal Code', 'Zip', 'Postal'],
    country: ['Country'],
    timezone: ['Timezone', 'Time Zone'],
    website: ['Website'],
    snapshot: ['Snapshot', 'Load Snapshot', 'Select Snapshot'],
    firstName: ['First Name'],
    lastName: ['Last Name'],
    submit: ['Create', 'Save', 'Add', 'Submit'],
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase()
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const st = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'
  }

  // ----------------------------------------------------------------- overlay
  let panel
  function show(lines, tone) {
    if (!panel) {
      panel = document.createElement('div')
      panel.id = 'genisys-ghl-panel'
      Object.assign(panel.style, {
        position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483647, maxWidth: '360px',
        background: '#111827', color: '#f9fafb', font: '13px/1.45 system-ui, sans-serif', borderRadius: '10px',
        padding: '12px 14px', boxShadow: '0 10px 30px rgba(0,0,0,.35)', border: '1px solid #374151', whiteSpace: 'pre-wrap',
      })
      document.body.appendChild(panel)
    }
    panel.style.borderColor = tone === 'error' ? '#f87171' : tone === 'ok' ? '#34d399' : '#374151'
    panel.textContent = `Genisys Hub\n${lines}`
  }

  // ----------------------------------------------------------------- finding things
  function* textNodes(root) {
    const all = root.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="option"], li, div, span, label, h1, h2, h3, h4, p')
    for (const el of all) yield el
  }

  function findByText(words, { roles, exact = false, root = document } = {}) {
    const wants = words.map(norm)
    let best = null
    for (const el of textNodes(root)) {
      if (!visible(el)) continue
      if (roles && !roles.some((r) => el.matches(r))) continue
      const t = norm(el.textContent)
      if (!t || t.length > 80) continue
      const hit = exact ? wants.includes(t) : wants.some((w) => t === w || t.startsWith(w + ' ') || t.endsWith(' ' + w) || t === w)
      if (!hit) continue
      // Prefer the innermost (fewest children) match: the button itself, not its container.
      if (!best || el.childElementCount < best.childElementCount) best = el
    }
    return best
  }

  function clickable(el) {
    return el.closest('button, a, [role="button"], [role="menuitem"], [role="option"], li') || el
  }

  async function waitFor(fn, ms, what) {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const v = fn()
      if (v) return v
      await sleep(250)
    }
    throw new Error(`Couldn't find ${what}`)
  }

  function fieldFor(words, root = document) {
    const wants = words.map(norm)
    const inputs = [...root.querySelectorAll('input, textarea, select')].filter(visible).filter((i) => !['hidden', 'checkbox', 'radio', 'submit', 'button', 'file'].includes(i.type))
    // 1. <label for=…> or a label wrapping the input
    for (const lab of root.querySelectorAll('label')) {
      const t = norm(lab.textContent).replace(/\*$/, '').trim()
      if (!wants.includes(t)) continue
      const target = (lab.htmlFor && root.querySelector(`#${CSS.escape(lab.htmlFor)}`)) || lab.querySelector('input, textarea, select') || lab.parentElement?.querySelector('input, textarea, select')
      if (target && visible(target)) return target
    }
    // 2. placeholder / name / aria-label / id
    for (const i of inputs) {
      const keys = [i.placeholder, i.name, i.getAttribute('aria-label'), i.id].map(norm)
      if (keys.some((k) => k && wants.some((w) => k === w || k.includes(w)))) return i
    }
    // 3. a heading-ish text right before the input
    for (const i of inputs) {
      const prev = i.closest('div')?.previousElementSibling
      if (prev && wants.includes(norm(prev.textContent).replace(/\*$/, '').trim())) return i
    }
    return null
  }

  function setValue(el, value) {
    el.focus()
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) setter.call(el, value)
    else el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    el.dispatchEvent(new Event('blur', { bubbles: true }))
  }

  /** A select or a custom dropdown: open it, type to filter if possible, click the option with this text. */
  async function pick(el, text, what) {
    if (el.tagName === 'SELECT') {
      const opt = [...el.options].find((o) => norm(o.textContent) === norm(text) || norm(o.textContent).includes(norm(text)) || o.value === text)
      if (!opt) throw new Error(`${what}: no option "${text}"`)
      setValue(el, opt.value)
      return
    }
    clickable(el).click()
    await sleep(300)
    if (el.tagName === 'INPUT') {
      setValue(el, text)
      await sleep(600)
    }
    const opt = await waitFor(() => findByText([text], { roles: ['[role="option"]', 'li', 'div', 'span'] }), 6000, `${what} option "${text}"`)
    clickable(opt).click()
    await sleep(300)
  }

  // ----------------------------------------------------------------- the job
  async function run(job, mode, labels) {
    const L = { ...DEFAULT_LABELS, ...(labels || {}) }
    const f = job.fields
    const steps = []
    const step = (s) => {
      steps.push(s)
      show(`${f.name}\n${steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}`)
    }

    // 1. Get to the create form. If a form with a business-name field is already open, use it.
    let form = fieldFor(L.name) ? document : null
    if (!form) {
      step('Opening Sub-Accounts')
      const nav = findByText(L.subAccountsNav)
      if (nav) {
        clickable(nav).click()
        await sleep(1500)
      }
      step('Opening the create form')
      const create = await waitFor(() => findByText(L.createButton, { roles: ['button', 'a', '[role="button"]'] }), 15000, 'the "Create Sub-Account" button (the page may still be loading, or you may not be in the agency view)')
      clickable(create).click()
      await sleep(1200)
      const add = findByText(L.addBusiness)
      if (add) {
        clickable(add).click()
        await sleep(1200)
      }
      await waitFor(() => fieldFor(L.name), 15000, 'the business-name field on the create form')
      form = document
    }

    // 2. Fill what the Hub sent. Anything not on the page is reported, not guessed.
    const missing = []
    const fill = async (key, words, value) => {
      if (!value) return
      const el = fieldFor(words)
      if (!el) {
        missing.push(key)
        return
      }
      if (el.tagName === 'SELECT') await pick(el, value, key)
      else setValue(el, value)
      await sleep(150)
    }
    step('Filling the business details')
    await fill('name', L.name, f.name)
    await fill('email', L.email, job.owner.email)
    await fill('phone', L.phone, f.phone)
    await fill('address', L.address, f.address)
    await fill('city', L.city, f.city)
    await fill('postalCode', L.postalCode, f.postalCode)
    await fill('website', L.website, f.website)
    for (const [key, words, value] of [['country', L.country, f.country === 'US' ? 'United States' : f.country], ['state', L.state, f.state], ['timezone', L.timezone, f.timezone]]) {
      if (!value) continue
      const el = fieldFor(words)
      if (!el) {
        missing.push(key)
        continue
      }
      try {
        await pick(el, value, key)
      } catch (err) {
        missing.push(`${key} (${err.message})`)
      }
    }
    await fill('firstName', L.firstName, job.owner.firstName)
    await fill('lastName', L.lastName, job.owner.lastName)

    // 3. The snapshot — the part that matters most; stop if it can't be picked.
    step(`Picking the snapshot${job.snapshot.name ? ` "${job.snapshot.name}"` : ''}`)
    const snapEl = fieldFor(L.snapshot) || findByText(L.snapshot)
    if (!snapEl) throw new Error('the snapshot picker on the form — pick it by hand, then press Create')
    await pick(snapEl, job.snapshot.name || job.snapshot.id, 'snapshot')

    const note = missing.length ? `Not filled (not found on the form): ${missing.join(', ')}.` : ''

    // 4. Create, or hand over.
    if (mode !== 'create') {
      show(`${f.name}\nFilled in. ${note}\n\nCheck it over and press Create yourself; the Hub links it by name afterwards.`, 'ok')
      return { status: 'skipped', detail: `Filled the form; left for a person to press Create. ${note}`.trim() }
    }
    step('Pressing Create')
    const before = location.href
    const submit = await waitFor(() => {
      const b = findByText(L.submit, { roles: ['button', '[role="button"]'], exact: true })
      return b && !b.disabled ? b : null
    }, 8000, 'the Create button')
    clickable(submit).click()

    // 5. Success = GHL moves into the new location, the form goes away, or a "created" toast.
    const outcome = await waitFor(() => {
      const m = /\/location\/([A-Za-z0-9]{10,})/.exec(location.href)
      if (m && location.href !== before) return { locationId: m[1] }
      if (!fieldFor(L.name)) return { locationId: null }
      const toast = findByText(['created', 'successfully'])
      return toast ? { locationId: null } : null
    }, 60000, 'confirmation that GHL created it (the form is still open — check for a validation message)')
    show(`${f.name}\nCreated. ${note}`, 'ok')
    return { status: 'created', locationId: outcome.locationId, detail: note || null }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type !== 'ghl-job') return false
    show(`${msg.job.fields.name}\nStarting…`)
    run(msg.job, msg.mode, msg.labels)
      .then((result) => chrome.runtime.sendMessage({ type: 'ghl-job-result', clientId: msg.job.clientId, result }))
      .catch((err) => {
        show(`${msg.job.fields.name}\nStopped: ${err.message}\n\nFinish it by hand from the Hub's Sub-account board.`, 'error')
        chrome.runtime.sendMessage({ type: 'ghl-job-result', clientId: msg.job.clientId, result: { status: 'failed', detail: err.message } })
      })
    reply({ ok: true })
    return true
  })
})()
