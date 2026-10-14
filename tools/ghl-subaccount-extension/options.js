const DEFAULTS = { enabled: false, hubUrl: 'https://genisys-hub.onrender.com', token: '', ghlUrl: 'https://app.gohighlevel.com', mode: 'fill', pollMinutes: 3, labels: '' }
const $ = (id) => document.getElementById(id)
const status = (text, cls) => {
  const el = $('status')
  el.textContent = text
  el.className = cls || ''
}

async function load() {
  const s = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) }
  $('enabled').checked = !!s.enabled
  $('hubUrl').value = s.hubUrl
  $('token').value = s.token
  $('ghlUrl').value = s.ghlUrl
  $('mode').value = s.mode
  $('pollMinutes').value = s.pollMinutes
  $('labels').value = s.labels
}

async function save() {
  const labels = $('labels').value.trim()
  if (labels) {
    try {
      JSON.parse(labels)
    } catch {
      status('The wording overrides must be valid JSON.', 'err')
      return
    }
  }
  await chrome.storage.sync.set({
    enabled: $('enabled').checked,
    hubUrl: $('hubUrl').value.trim().replace(/\/+$/, '') || DEFAULTS.hubUrl,
    token: $('token').value.trim(),
    ghlUrl: $('ghlUrl').value.trim().replace(/\/+$/, '') || DEFAULTS.ghlUrl,
    mode: $('mode').value,
    pollMinutes: Math.max(1, Number($('pollMinutes').value) || 3),
    labels,
  })
  await chrome.runtime.sendMessage({ type: 'reschedule' })
  status('Saved.', 'ok')
}

async function test() {
  status('Testing…')
  await save()
  const r = await chrome.runtime.sendMessage({ type: 'test-hub' })
  if (r?.ok) status(`Connected as ${r.who}. ${r.waiting} client${r.waiting === 1 ? '' : 's'} waiting${r.enabled ? '' : ' (Hub automation is switched off)'}.`, 'ok')
  else status(r?.error || 'Failed', 'err')
}

$('save').addEventListener('click', save)
$('test').addEventListener('click', test)
load()
