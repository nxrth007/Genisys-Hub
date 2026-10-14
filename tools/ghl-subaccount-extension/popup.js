const $ = (id) => document.getElementById(id)

async function renderLog() {
  const { log = [] } = await chrome.storage.local.get('log')
  const s = await chrome.storage.sync.get({ enabled: false, mode: 'fill' })
  $('state').textContent = s.enabled ? `on · ${s.mode === 'create' ? 'fills and creates' : 'fills, you press Create'}` : 'switched off'
  $('log').innerHTML = log.length
    ? log.map((e) => `<li class="${e.level}"><time>${new Date(e.at).toLocaleString()}</time>${escapeHtml(e.text)}</li>`).join('')
    : '<li>Nothing yet.</li>'
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

$('run').addEventListener('click', async () => {
  $('run').disabled = true
  $('state').textContent = 'running…'
  const r = await chrome.runtime.sendMessage({ type: 'run-now' })
  $('run').disabled = false
  if (!r?.ok) $('state').textContent = r?.error || 'failed'
  else if (r.did === 'nothing') $('state').textContent = r.reason || 'nothing to do'
  await renderLog()
})
$('options').addEventListener('click', (e) => {
  e.preventDefault()
  chrome.runtime.openOptionsPage()
})
renderLog()
