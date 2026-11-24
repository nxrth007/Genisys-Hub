/**
 * GET /hl/work.js: the Recent Work feed for client websites.
 *
 *   <script src="https://genisys-hub.onrender.com/hl/work.js" data-account="ACCOUNT_ID" async></script>
 *   <div data-hl-work="ACCOUNT_ID"></div>
 *
 * A grid of the photos the owner texted to their business number (src/lib/hl/work-photos.ts), under
 * a small heading, in every [data-hl-work="ACCOUNT_ID"] on the page. Client sites are single-page
 * apps, so the script is loaded once (index.html) and the placeholder sits on the Gallery page: the
 * feed watches for it and fills it whenever that page shows. With data-inline on the tag (a plain HTML
 * page), it renders right after itself instead. Nothing at all until there's a photo, so a site's own
 * gallery stays as it is. Plain ES5 with inline styles, as the chat bubble is.
 */
const SCRIPT = `(function () {
  var s = document.currentScript || document.querySelector('script[data-account][src*="/hl/work.js"]');
  if (!s) return;
  var account = s.getAttribute('data-account');
  if (!account || !window.fetch) return;
  var origin = new URL(s.src).origin;
  var heading = s.getAttribute('data-heading') || 'Recent work';
  var max = parseInt(s.getAttribute('data-max') || '12', 10) || 12;
  var font = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';
  var feed = null;

  function el(tag, css) { var e = document.createElement(tag); if (css) e.style.cssText = css; return e; }
  function when(d) { try { var t = new Date(d); return isNaN(t) ? '' : t.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch (e) { return ''; } }

  function fill(box) {
    if (!feed || !feed.photos || !feed.photos.length || box.getAttribute('data-hl-work-done') === account) return;
    box.setAttribute('data-hl-work-done', account);
    box.innerHTML = '';
    box.style.cssText += ';font-family:' + font + ';margin:0 0 32px';
    var h = el('h2', 'margin:0 0 14px;font:600 22px/1.2 ' + font);
    h.textContent = heading;
    box.appendChild(h);
    var grid = el('div', 'display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px');
    feed.photos.slice(0, max).forEach(function (p) {
      var a = el('a', 'display:block;position:relative;aspect-ratio:1/1;overflow:hidden;border-radius:14px;background:#EEF0F3;text-decoration:none;color:inherit');
      a.href = p.url;
      a.target = '_blank';
      a.rel = 'noopener';
      var img = el('img', 'width:100%;height:100%;object-fit:cover;display:block;transition:transform .35s ease');
      img.src = p.url;
      img.alt = p.caption || (feed.business + ': recent work');
      img.loading = 'lazy';
      img.decoding = 'async';
      a.appendChild(img);
      a.addEventListener('mouseenter', function () { img.style.transform = 'scale(1.04)'; });
      a.addEventListener('mouseleave', function () { img.style.transform = 'none'; });
      var cap = p.caption ? p.caption : when(p.at);
      if (cap) {
        var c = el('span', 'position:absolute;left:0;right:0;bottom:0;padding:22px 12px 10px;font:500 13px/1.3 ' + font + ';color:#fff;background:linear-gradient(to top,rgba(16,24,40,.72),rgba(16,24,40,0))');
        c.textContent = cap;
        a.appendChild(c);
      }
      grid.appendChild(a);
    });
    box.appendChild(grid);
  }

  // Every placeholder on the page now, and any the app shows later (a route change).
  function sweep() {
    var boxes = document.querySelectorAll('[data-hl-work="' + account + '"]');
    for (var i = 0; i < boxes.length; i++) fill(boxes[i]);
  }
  var pending = null;
  function watch() {
    if (!window.MutationObserver || !document.body) return;
    new MutationObserver(function () {
      if (pending) return;
      pending = setTimeout(function () { pending = null; sweep(); }, 150);
    }).observe(document.body, { childList: true, subtree: true });
  }
  function start() {
    // Asked to render right here (a plain HTML page, no placeholder): never guessed, since an app can mount the tag anywhere.
    if (s.hasAttribute('data-inline') && !document.querySelector('[data-hl-work="' + account + '"]')) {
      var box = el('div');
      box.setAttribute('data-hl-work', account);
      s.parentNode.insertBefore(box, s.nextSibling);
    }
    sweep();
    watch();
  }
  function ready(fn) { if (document.body) fn(); else document.addEventListener('DOMContentLoaded', fn); }
  fetch(origin + '/api/hl/public/work/' + encodeURIComponent(account)).then(function (r) { return r.ok ? r.json() : null; }).then(function (f) { if (f && f.photos && f.photos.length) { feed = f; ready(start); } }, function () {});
})();`

export function GET() {
  return new Response(SCRIPT, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'access-control-allow-origin': '*',
    },
  })
}
