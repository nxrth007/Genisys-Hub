/**
 * Runs inside the GHL page (Playwright evaluates it as a string, so the
 * bundler cannot rewrite it and the page's CSP does not apply).
 *
 * One function, one command: snapshot the visible form, or click / fill
 * / pick by the words a person would read. Kept as a string on purpose.
 */
export const GHL_PAGE_SOURCE = `function(cmd) {
  var labels = cmd.labels || {}
  function norm(s) {
    return String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase()
  }
  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false
    var r = el.getBoundingClientRect()
    var st = window.getComputedStyle(el)
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'
  }
  function wordsOf(key) {
    var list = labels[key] || []
    var out = []
    for (var i = 0; i < list.length; i++) out.push(norm(list[i]))
    return out
  }
  function hitWord(text, word) {
    if (!text || !word) return false
    if (word.length <= 4) return text === word
    return text === word || text.indexOf(word) !== -1
  }
  function textOf(el) {
    return norm(el.innerText || el.textContent || '')
  }
  function collect(selector) {
    var all = document.querySelectorAll(selector)
    var out = []
    for (var i = 0; i < all.length; i++) {
      if (!visible(all[i])) continue
      var t = textOf(all[i])
      if (!t || t.length > 80) continue
      out.push(all[i])
    }
    return out
  }
  function findByText(words, exact, contains) {
    var wants = []
    for (var i = 0; i < (words || []).length; i++) wants.push(norm(words[i]))
    var nodes = collect('button, a, [role="button"], [role="tab"], [role="menuitem"], [role="option"], li, div, span')
    var best = null
    for (var n = 0; n < nodes.length; n++) {
      var t = textOf(nodes[n])
      var ok = false
      for (var w = 0; w < wants.length; w++) {
        if (exact) {
          if (t === wants[w]) ok = true
        } else if (contains) {
          var tw = t.replace(/^[+\\uFF0B]\\s*/, '')
          var ww = wants[w].replace(/^[+\\uFF0B]\\s*/, '')
          if (tw === ww || (ww.length > 4 && tw.indexOf(ww) !== -1)) ok = true
        } else if (t === wants[w] || t.indexOf(wants[w] + ' ') === 0 || t.slice(-(wants[w].length + 1)) === ' ' + wants[w]) {
          ok = true
        }
      }
      if (!ok) continue
      if (!best || nodes[n].childElementCount < best.childElementCount) best = nodes[n]
    }
    return best
  }
  function clickable(el) {
    return el.closest('button, a, [role="button"], [role="menuitem"], [role="option"], li') || el
  }
  function setValue(el, value) {
    el.focus()
    var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype
    var desc = Object.getOwnPropertyDescriptor(proto, 'value')
    if (desc && desc.set) desc.set.call(el, value)
    else el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    el.dispatchEvent(new Event('blur', { bubbles: true }))
  }
  function inputsOf() {
    return document.querySelectorAll('input, textarea, select')
  }
  function skipType(type) {
    return type === 'hidden' || type === 'checkbox' || type === 'radio' || type === 'submit' || type === 'button' || type === 'file'
  }
  function fieldFor(words, key) {
    var wants = []
    for (var i = 0; i < (words || []).length; i++) wants.push(norm(words[i]))
    var inputs = inputsOf()
    var labs = document.querySelectorAll('label')
    for (var l = 0; l < labs.length; l++) {
      var t = norm(labs[l].textContent).replace(/\\*$/, '').trim()
      var match = false
      for (var w = 0; w < wants.length; w++) if (t === wants[w]) match = true
      if (!match) continue
      var target = labs[l].htmlFor ? document.getElementById(labs[l].htmlFor) : null
      if (!target) target = labs[l].querySelector('input, textarea, select')
      if (!target && labs[l].parentElement) target = labs[l].parentElement.querySelector('input, textarea, select')
      if (target && visible(target)) return target
    }
    for (var j = 0; j < inputs.length; j++) {
      var el = inputs[j]
      if (!visible(el)) continue
      var type = (el.type || '').toLowerCase()
      if (skipType(type)) continue
      var bits = [norm(el.placeholder), norm(el.name), norm(el.getAttribute('aria-label')), norm(el.id)]
      for (var k = 0; k < bits.length; k++) {
        for (var w2 = 0; w2 < wants.length; w2++) {
          if (bits[k] && hitWord(bits[k], wants[w2])) return el
        }
      }
    }
    if (key === 'password' || key === 'otp') {
      for (var p = 0; p < inputs.length; p++) {
        var cand = inputs[p]
        if (!visible(cand)) continue
        var ct = (cand.type || '').toLowerCase()
        if (key === 'password' && ct === 'password') return cand
        if (key === 'otp' && (ct === 'text' || ct === 'tel' || ct === 'number' || ct === '')) return cand
      }
    }
    return null
  }
  function fieldKey(el) {
    var labelText = ''
    if (el.id) {
      var lab = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]')
      if (lab) labelText = norm(lab.textContent).replace(/\\*$/, '').trim()
    }
    if (!labelText) {
      var wrap = el.closest('label')
      if (wrap) labelText = norm(wrap.textContent).replace(/\\*$/, '').trim()
    }
    var bits = [labelText, norm(el.placeholder), norm(el.getAttribute('aria-label')), norm(el.name)]
    var keys = Object.keys(labels)
    for (var i = 0; i < keys.length; i++) {
      var wants = wordsOf(keys[i])
      for (var j = 0; j < wants.length; j++) {
        for (var k = 0; k < bits.length; k++) {
          if (hitWord(bits[k], wants[j])) return keys[i]
        }
      }
    }
    return null
  }
  function labelFor(el) {
    var labelText = ''
    if (el.id) {
      var lab = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]')
      if (lab) labelText = textOf(lab)
    }
    if (!labelText && el.closest) {
      var wrap = el.closest('label')
      if (wrap) labelText = textOf(wrap)
    }
    return labelText
  }
  function snapshot() {
    var fields = []
    var inputs = inputsOf()
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i]
      if (!visible(el)) continue
      var type = (el.type || '').toLowerCase()
      if (skipType(type)) continue
      fields.push({
        key: fieldKey(el),
        tag: el.tagName.toLowerCase(),
        type: type || (el.tagName === 'SELECT' ? 'select' : 'text'),
        value: el.value || '',
        text: norm(labelFor(el) || el.getAttribute('aria-label') || ''),
        placeholder: norm(el.placeholder || '')
      })
    }
    var buttons = []
    var seen = {}
    var bnodes = collect('button, a, [role="button"], [role="tab"]')
    for (var b = 0; b < bnodes.length; b++) {
      var bt = textOf(bnodes[b]) || norm(bnodes[b].getAttribute('aria-label') || bnodes[b].getAttribute('title') || '')
      if (!bt || seen[bt]) continue
      seen[bt] = 1
      buttons.push(bt)
    }
    var texts = []
    var tseen = {}
    var tnodes = collect('li, [role="option"], [role="row"], td')
    for (var t = 0; t < tnodes.length && texts.length < 200; t++) {
      var tt = textOf(tnodes[t])
      if (!tseen[tt]) { tseen[tt] = 1; texts.push(tt) }
    }
    var links = []
    var anchors = document.querySelectorAll('a')
    for (var a = 0; a < anchors.length && links.length < 200; a++) {
      if (!visible(anchors[a])) continue
      var lt = textOf(anchors[a])
      if (!lt || lt.length > 80) continue
      links.push({ text: lt, href: anchors[a].href || '' })
    }
    var checks = []
    var cboxes = document.querySelectorAll('input[type=checkbox], [role=checkbox]')
    for (var c = 0; c < cboxes.length && checks.length < 12; c++) {
      var box = cboxes[c]
      if (!visible(box) && box.getAttribute('role') !== 'checkbox') continue
      var clabel = ''
      if (box.id) {
        var clab = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(box.id) : box.id) + '"]')
        if (clab) clabel = textOf(clab)
      }
      if (!clabel && box.closest) {
        var cwrap = box.closest('label')
        if (cwrap) clabel = textOf(cwrap)
      }
      if (!clabel && box.parentElement) clabel = textOf(box.parentElement)
      if (!clabel) continue
      checks.push({ text: clabel, checked: !!(box.checked || box.getAttribute('aria-checked') === 'true') })
    }
    var body = ''
    try { body = String((document.body && document.body.innerText) || '').slice(0, 2500).toLowerCase() } catch (e) { body = '' }
    var tabs = []
    var tabSeen = {}
    var tabNodes = document.querySelectorAll('[role=tab], button, a, [role=button]')
    for (var tb = 0; tb < tabNodes.length && tabs.length < 12; tb++) {
      if (!visible(tabNodes[tb])) continue
      var tabText = textOf(tabNodes[tb])
      if (!/snapshot templates|my snapshots|imported snapshots/.test(tabText) || tabSeen[tabText]) continue
      tabSeen[tabText] = 1
      tabs.push(tabText)
    }
    var cards = []
    var cardSeen = {}
    var dialog = document.querySelector('[role=dialog], [aria-modal=true]') || null
    if (dialog) {
      var cardNodes = dialog.querySelectorAll('h1, h2, h3, h4, p, span, div')
      for (var cd = 0; cd < cardNodes.length && cards.length < 80; cd++) {
        var cardEl = cardNodes[cd]
        if (!visible(cardEl)) continue
        var own = ''
        for (var cn = 0; cn < cardEl.childNodes.length; cn++) {
          if (cardEl.childNodes[cn].nodeType === 3) own += cardEl.childNodes[cn].textContent || ''
        }
        own = norm(own)
        if (own.length < 3 || own.length > 80 || cardSeen[own]) continue
        if (/select & continue|select and continue|^cancel$|snapshot templates|my snapshots|imported snapshots|select snapshot/.test(own)) continue
        cardSeen[own] = 1
        cards.push(own)
      }
    }
    return { url: String(location.href || ''), fields: fields, buttons: buttons, texts: texts, links: links, checks: checks, tabs: tabs, cards: cards, overlays: overlayTexts(), body: body }
  }
  function overlayTexts() {
    var out = []
    var seen = {}
    var nodes = document.querySelectorAll('[role=dialog], .modal, [class*=drawer], [class*=Drawer], [class*=modal]')
    for (var i = 0; i < nodes.length && out.length < 12; i++) {
      if (!visible(nodes[i])) continue
      var t = textOf(nodes[i]).slice(0, 160)
      if (!t || seen[t]) continue
      seen[t] = 1
      out.push(t)
    }
    return out
  }
  if (cmd.op === 'snapshot') return snapshot()
  if (cmd.op === 'fill' || cmd.op === 'pick') {
    var el = fieldFor(cmd.words || [], cmd.key)
    if (!el) return { ok: false, error: 'Could not find a field for ' + (cmd.words || []).join(' / ') }
    if (cmd.op === 'fill' && el.tagName !== 'SELECT') {
      setValue(el, cmd.value == null ? '' : String(cmd.value))
      return { ok: true }
    }
    if (el.tagName === 'SELECT') {
      var opts = el.options || []
      var want = norm(cmd.value)
      var chosen = null
      for (var o = 0; o < opts.length; o++) {
        var ot = norm(opts[o].textContent)
        if (ot === want || (want && ot.indexOf(want) !== -1) || opts[o].value === cmd.value) { chosen = opts[o]; break }
      }
      if (!chosen) return { ok: false, retry: true, error: 'No option "' + cmd.value + '"' }
      setValue(el, chosen.value)
      return { ok: true }
    }
    clickable(el).click()
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') setValue(el, cmd.value == null ? '' : String(cmd.value))
    var opt = findByText([String(cmd.value || '')], false)
    if (!opt) return { ok: false, retry: true, error: 'No option "' + cmd.value + '"' }
    clickable(opt).click()
    return { ok: true }
  }
  if (cmd.op === 'click') {
    var target = findByText(cmd.words || [], !!cmd.exact, !!cmd.contains)
    if (!target) return { ok: false, error: 'Could not find ' + (cmd.words || []).join(' / ') }
    var btn = clickable(target)
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return { ok: false, error: 'The control is disabled' }
    btn.click()
    var href = ''
    try {
      var link = target.closest ? target.closest('a') : null
      if (link && link.href) href = String(link.href)
      else if (target.href) href = String(target.href)
      else if (target.getAttribute) href = target.getAttribute('href') || ''
    } catch (e) {}
    return { ok: true, href: href }
  }
  function typeInto(el, value) {
    el.focus()
    setValue(el, value)
    try {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }))
      el.dispatchEvent(new KeyboardEvent('keyup', { key: value, bubbles: true }))
    } catch (e) {}
  }
  function digitBoxes() {
    var inputs = inputsOf()
    var boxes = []
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i]
      if (!visible(el)) continue
      var type = (el.type || '').toLowerCase()
      if (type === 'hidden' || type === 'checkbox' || type === 'radio' || type === 'password' || type === 'submit') continue
      if (el.getAttribute('maxlength') === '1' || el.maxLength === 1) boxes.push(el)
    }
    return boxes
  }
  if (cmd.op === 'fillOtp') {
    var code = String(cmd.value || '')
    var boxes = digitBoxes()
    if (boxes.length >= 4 && code.length >= 4 && boxes.length >= code.length) {
      for (var d = 0; d < code.length; d++) typeInto(boxes[d], code.charAt(d))
      return { ok: true, mode: 'boxes' }
    }
    var one = fieldFor((labels.otp || []), 'otp')
    if (!one) {
      var inputs = inputsOf()
      for (var j = 0; j < inputs.length; j++) {
        var cand = inputs[j]
        if (!visible(cand)) continue
        var ct = (cand.type || '').toLowerCase()
        if (ct === 'hidden' || ct === 'checkbox' || ct === 'radio' || ct === 'password') continue
        one = cand
        break
      }
    }
    if (!one) return { ok: false, error: 'No code box on the page' }
    typeInto(one, code)
    return { ok: true, mode: 'single' }
  }
  if (cmd.op === 'pressEnter') {
    var active = document.activeElement || document.body
    try {
      active.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
      active.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
    } catch (e) {}
    if (active && active.form && active.form.requestSubmit) {
      try { active.form.requestSubmit() } catch (e2) {}
    }
    return { ok: true }
  }
  if (cmd.op === 'remember') {
    var nodes = document.querySelectorAll('input[type=checkbox], [role=checkbox]')
    for (var r = 0; r < nodes.length; r++) {
      var box = nodes[r]
      var label = ''
      if (box.id) {
        var lab = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(box.id) : box.id) + '"]')
        if (lab) label = textOf(lab)
      }
      if (!label && box.closest) {
        var wrap = box.closest('label')
        if (wrap) label = textOf(wrap)
      }
      if (!label && box.parentElement) label = textOf(box.parentElement)
      if (!/remember|trust this device|trusted device|don.t ask|do not ask/.test(label)) continue
      var on = box.checked || box.getAttribute('aria-checked') === 'true'
      if (!on) clickable(box).click()
      var days = (label.match(/(\\d+)\\s*days/) || [])[1] || ''
      return { ok: true, ticked: true, label: label, days: days }
    }
    return { ok: true, ticked: false }
  }
  if (cmd.op === 'clickVerify') {
    var words = cmd.words || []
    var target = findByText(words, false)
    if (!target) {
      var submits = document.querySelectorAll('button, input[type=submit], [role=button]')
      for (var s = 0; s < submits.length; s++) {
        if (!visible(submits[s])) continue
        var aria = norm(submits[s].getAttribute('aria-label') || submits[s].getAttribute('title') || '')
        var labelText = textOf(submits[s])
        var hit = submits[s].getAttribute('type') === 'submit' && !labelText
        for (var w = 0; w < words.length && !hit; w++) {
          var want = norm(words[w])
          if (!want) continue
          if (labelText && (labelText === want || labelText.indexOf(want) !== -1)) hit = true
          if (aria && (aria === want || aria.indexOf(want) !== -1)) hit = true
        }
        if (hit) { target = submits[s]; break }
      }
    }
    if (!target) return { ok: false, error: 'No verify button' }
    var submitBtn = clickable(target)
    if (submitBtn.disabled || submitBtn.getAttribute('aria-disabled') === 'true') return { ok: false, error: 'The control is disabled' }
    submitBtn.click()
    return { ok: true }
  }
  return { ok: false, error: 'Unknown action' }
}`
