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
  function findByText(words, exact) {
    var wants = []
    for (var i = 0; i < (words || []).length; i++) wants.push(norm(words[i]))
    var nodes = collect('button, a, [role="button"], [role="menuitem"], [role="option"], li, div, span')
    var best = null
    for (var n = 0; n < nodes.length; n++) {
      var t = textOf(nodes[n])
      var ok = false
      for (var w = 0; w < wants.length; w++) {
        if (exact) {
          if (t === wants[w]) ok = true
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
        text: norm(el.getAttribute('aria-label') || el.placeholder || el.name || '')
      })
    }
    var buttons = []
    var seen = {}
    var bnodes = collect('button, a, [role="button"]')
    for (var b = 0; b < bnodes.length; b++) {
      var bt = textOf(bnodes[b])
      if (!seen[bt]) { seen[bt] = 1; buttons.push(bt) }
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
    var body = ''
    try { body = String((document.body && document.body.innerText) || '').slice(0, 2500).toLowerCase() } catch (e) { body = '' }
    return { url: String(location.href || ''), fields: fields, buttons: buttons, texts: texts, links: links, body: body }
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
    var target = findByText(cmd.words || [], !!cmd.exact)
    if (!target) return { ok: false, error: 'Could not find ' + (cmd.words || []).join(' / ') }
    var btn = clickable(target)
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return { ok: false, error: 'The control is disabled' }
    btn.click()
    return { ok: true }
  }
  return { ok: false, error: 'Unknown action' }
}`
