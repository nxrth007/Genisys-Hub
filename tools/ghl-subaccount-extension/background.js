/**
 * Genisys Hub — GHL sub-accounts (service worker).
 *
 * Every few minutes: ask the Hub for new clients that still need a GHL
 * sub-account. For the first one, open (or reuse) a GHL tab, run the
 * content script that fills GHL's create form, and report what happened
 * back to the Hub. One job at a time; the Hub does the linking.
 *
 * Settings (options page): Hub URL, Hub API token (Settings → API tokens,
 * made by an admin), GHL URL, mode ("fill" stops before the Create button;
 * "create" presses it), poll interval, on/off.
 */

const DEFAULTS = {
  enabled: false,
  hubUrl: 'https://genisys-hub.onrender.com',
  token: '',
  ghlUrl: 'https://app.gohighlevel.com',
  mode: 'fill',
  pollMinutes: 3,
  labels: '',
}
const ALARM = 'genisys-ghl-poll'
const JOB_TIMEOUT_MS = 4 * 60 * 1000

chrome.runtime.onInstalled.addListener(() => schedule())
chrome.runtime.onStartup.addListener(() => schedule())
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) void runOnce('alarm')
})
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'run-now') {
    runOnce('manual').then((r) => reply(r))
    return true
  }
  if (msg?.type === 'test-hub') {
    testHub().then((r) => reply(r))
    return true
  }
  if (msg?.type === 'reschedule') {
    schedule().then(() => reply({ ok: true }))
    return true
  }
  return false
})

async function settings() {
  const s = await chrome.storage.sync.get(DEFAULTS)
  return { ...DEFAULTS, ...s }
}

async function schedule() {
  const s = await settings()
  await chrome.alarms.clear(ALARM)
  if (s.enabled) chrome.alarms.create(ALARM, { periodInMinutes: Math.max(1, Number(s.pollMinutes) || 3) })
}

async function log(entry) {
  const { log = [] } = await chrome.storage.local.get('log')
  log.unshift({ at: new Date().toISOString(), ...entry })
  await chrome.storage.local.set({ log: log.slice(0, 50) })
}

async function hub(path, init = {}) {
  const s = await settings()
  if (!s.token) throw new Error('No Hub API token set (extension options).')
  const res = await fetch(`${s.hubUrl.replace(/\/+$/, '')}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.message || body.error || `Hub answered ${res.status}`)
  return body.data ?? body
}

async function testHub() {
  try {
    const me = await hub('/api/external/v1/me')
    const q = await hub('/api/external/v1/ghl-subaccounts/queue')
    return { ok: true, who: me.user?.email || me.tokenName, waiting: q.jobs?.length ?? 0, enabled: q.enabled }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

let running = false

async function runOnce(trigger) {
  if (running) return { ok: false, error: 'A job is already running.' }
  running = true
  try {
    const s = await settings()
    if (!s.enabled && trigger === 'alarm') return { ok: false, error: 'Switched off.' }
    const q = await hub('/api/external/v1/ghl-subaccounts/queue')
    if (!q.enabled) {
      await log({ level: 'info', text: 'The Hub has sub-account automation switched off; nothing to do.' })
      return { ok: true, did: 'nothing', reason: 'Hub automation is off' }
    }
    const job = (q.jobs || [])[0]
    if (!job) return { ok: true, did: 'nothing', reason: 'No clients waiting.' }

    await log({ level: 'info', text: `Starting: ${job.fields.name || job.clientName}` })
    const tab = await ghlTab(s.ghlUrl)
    const result = await runJobInTab(tab.id, job, s)
    await hub('/api/external/v1/ghl-subaccounts/report', {
      method: 'POST',
      body: JSON.stringify({ clientId: job.clientId, status: result.status, locationId: result.locationId || null, detail: result.detail || null }),
    })
    await log({ level: result.status === 'created' ? 'ok' : result.status === 'failed' ? 'error' : 'info', text: `${job.fields.name || job.clientName}: ${result.status}${result.detail ? ` — ${result.detail}` : ''}` })
    if (result.status !== 'skipped') {
      chrome.notifications?.create({
        type: 'basic',
        iconUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        title: result.status === 'created' ? 'GHL sub-account created' : 'GHL sub-account needs you',
        message: `${job.fields.name || job.clientName}: ${result.detail || result.status}`,
      })
    }
    return { ok: true, did: result.status, client: job.clientName, detail: result.detail }
  } catch (err) {
    await log({ level: 'error', text: err.message })
    return { ok: false, error: err.message }
  } finally {
    running = false
  }
}

/** A GHL tab in this browser: an open one, else a new one at the agency dashboard. */
async function ghlTab(ghlUrl) {
  const origin = new URL(ghlUrl).origin
  const tabs = await chrome.tabs.query({ url: `${origin}/*` })
  const existing = tabs.find((t) => !t.discarded)
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true })
    return existing
  }
  const tab = await chrome.tabs.create({ url: `${origin}/agency_dashboard/`, active: true })
  await new Promise((r) => setTimeout(r, 4000))
  return tab
}

/** Inject content.js with the job and wait for its result message. */
function runJobInTab(tabId, job, s) {
  return new Promise(async (resolve) => {
    const timer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(onMsg)
      resolve({ status: 'failed', detail: 'Timed out after 4 minutes — the GHL page may have changed, or it was waiting for a login.' })
    }, JOB_TIMEOUT_MS)
    function onMsg(msg, sender) {
      if (msg?.type !== 'ghl-job-result' || sender.tab?.id !== tabId || msg.clientId !== job.clientId) return
      clearTimeout(timer)
      chrome.runtime.onMessage.removeListener(onMsg)
      resolve(msg.result)
    }
    chrome.runtime.onMessage.addListener(onMsg)
    try {
      let labels = null
      try {
        labels = s.labels ? JSON.parse(s.labels) : null
      } catch {
        labels = null
      }
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
      await chrome.tabs.sendMessage(tabId, { type: 'ghl-job', job, mode: s.mode, labels })
    } catch (err) {
      clearTimeout(timer)
      chrome.runtime.onMessage.removeListener(onMsg)
      resolve({ status: 'failed', detail: `Couldn't run in the GHL tab: ${err.message}` })
    }
  })
}
