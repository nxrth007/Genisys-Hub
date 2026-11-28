/*
 * Genisys OS's service worker (registered by src/components/genisys-os/phone-app.tsx, scope /genisys-os).
 *
 * - Offline: when a Genisys OS page can't load because the phone is offline, a plain "you're
 *   offline" screen instead of the browser's error page. Nothing is cached: leads, texts and
 *   calendars always come fresh from the Hub. This fetch handler is also what lets Chrome on
 *   Android offer to install the app.
 * - Notifications (src/lib/hl/push.ts sends them): a lead's text, form, chat or missed call shows
 *   on the lock screen, the app icon's badge shows how many conversations wait, and a tap opens the
 *   conversation.
 */

const OFFLINE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#09090b">
<title>Offline · Genisys OS</title>
<style>
  html, body { height: 100%; margin: 0; background: #09090b; color: #fafafa; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { min-height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 32px 28px calc(32px + env(safe-area-inset-bottom)); box-sizing: border-box; text-align: center; }
  .mark { width: 56px; height: 56px; border-radius: 14px; background: linear-gradient(#202024, #050506); display: grid; place-items: center; box-shadow: 0 0 0 1px rgb(255 255 255 / 0.08); }
  h1 { margin: 8px 0 0; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
  p { margin: 0; max-width: 300px; font-size: 15px; line-height: 1.5; color: rgb(250 250 250 / 0.6); }
  button { margin-top: 12px; height: 46px; padding: 0 26px; border: 0; border-radius: 10px; background: #fafafa; color: #09090b; font: inherit; font-size: 15px; font-weight: 600; }
</style>
</head>
<body>
<main>
  <div class="mark" aria-hidden="true">
    <svg width="30" height="30" viewBox="0 0 64 64"><path d="M44.02 19.98A17 17 0 1 0 49 32H33" fill="none" stroke="#fff" stroke-width="8"/></svg>
  </div>
  <h1>You're offline</h1>
  <p>Genisys OS needs a connection to load your leads, texts and calendar. Check your signal or Wi-Fi.</p>
  <button type="button" onclick="location.reload()">Try again</button>
</main>
</body>
</html>`

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  // Page loads only. Data requests, scripts and images go to the network as if this weren't here.
  if (event.request.mode !== 'navigate') return
  event.respondWith(
    fetch(event.request).catch(
      () => new Response(OFFLINE_PAGE, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }),
    ),
  )
})

// A notification from the Hub: { title, body, url, tag, unread }. Every push shows one (browsers require it).
self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }
  const shown = self.registration.showNotification(data.title || 'Genisys OS', {
    body: data.body || 'Something new in Messages',
    icon: '/icons/genisys-os-192.png',
    badge: '/icons/genisys-os-badge.png',
    // One per conversation: a second text from the same lead replaces the first, and still buzzes.
    tag: data.tag || undefined,
    renotify: !!data.tag,
    timestamp: Date.now(),
    data: { url: typeof data.url === 'string' && data.url.startsWith('/genisys-os') ? data.url : '/genisys-os' },
  })
  const badge =
    typeof data.unread === 'number' && self.navigator && 'setAppBadge' in self.navigator
      ? (data.unread > 0 ? self.navigator.setAppBadge(data.unread) : self.navigator.clearAppBadge()).catch(() => undefined)
      : undefined
  event.waitUntil(Promise.all([shown, badge]))
})

// A tap: back to an open Genisys OS window on that conversation, else open one there.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL((event.notification.data && event.notification.data.url) || '/genisys-os', self.location.origin).href
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const w of windows) {
        if (!w.url.startsWith(self.registration.scope)) continue
        try {
          const focused = await w.focus()
          await (focused || w).navigate(url)
          return
        } catch {
          // a window this worker can't steer: open a fresh one below
        }
      }
      await self.clients.openWindow(url)
    })(),
  )
})

// The browser renewed the subscription (it does, now and then): tell the Hub, keeping what this device followed.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription
      const fresh =
        event.newSubscription ||
        (old && old.options && old.options.applicationServerKey
          ? await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: old.options.applicationServerKey })
          : null)
      if (!fresh) return
      const json = fresh.toJSON()
      await fetch('/api/hl/push', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, replaces: old ? old.endpoint : null }),
      })
    })().catch(() => undefined),
  )
})
