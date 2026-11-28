/*
 * Genisys OS's service worker (registered by src/components/genisys-os/phone-app.tsx, scope /genisys-os).
 *
 * It does one thing: when a Genisys OS page can't load because the phone is offline, it shows a
 * plain "you're offline" screen instead of the browser's error page. Nothing is cached: leads,
 * texts and calendars always come fresh from the Hub. Having a fetch handler is also what lets
 * Chrome on Android offer to install the app.
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
