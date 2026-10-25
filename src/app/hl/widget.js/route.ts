/**
 * GET /hl/widget.js: the chat bubble for client websites.
 *
 *   <script src="https://genisys-hub.onrender.com/hl/widget.js" data-form="FORM_ID" async></script>
 *
 * Adds a round button in the corner; clicking it opens the chat widget form
 * (served by the Hub at /hl/c/FORM_ID) in a panel, full screen on a phone.
 * A few seconds in, a greeting with the business logo pops up beside it, as
 * GHL's does, until the visitor closes it. Plain ES5: it runs on whatever the
 * client's site is, waits for the page body, and starts once however many
 * times it's included.
 */
const SCRIPT = `(function () {
  var s = document.currentScript || document.querySelector('script[data-form][src*="/hl/widget.js"]');
  if (!s || window.__hlWidget) return;
  window.__hlWidget = true;
  var form = s.getAttribute('data-form');
  if (!form) return;
  var origin = new URL(s.src).origin;
  var side = s.getAttribute('data-position') === 'left' ? 'left' : 'right';
  var store = { get: function (k) { try { return window.localStorage.getItem(k) } catch (e) { return null } }, set: function (k, v) { try { window.localStorage.setItem(k, v) } catch (e) {} } };
  var seenKey = 'hl-chat-greeting-' + form;

  function start(cfg) {
    var color = s.getAttribute('data-color') || cfg.color || '#155EEF';
    var open = false;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Chat with us');
    btn.style.cssText = 'position:fixed;bottom:20px;' + side + ':20px;width:60px;height:60px;border-radius:50%;border:0;cursor:pointer;z-index:2147483646;box-shadow:0 8px 24px rgba(16,24,40,.25);display:flex;align-items:center;justify-content:center;padding:0;background:' + color;
    var chatIcon = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    var closeIcon = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    btn.innerHTML = chatIcon;

    var panel = document.createElement('div');
    var frame = document.createElement('iframe');
    frame.title = 'Chat with us';
    frame.style.cssText = 'width:100%;height:100%;border:0;display:block';
    panel.appendChild(frame);
    var phone = function () { return window.innerWidth < 520; };
    function place() {
      if (phone()) {
        panel.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;width:100%;height:100%;z-index:2147483647;background:#fff;display:' + (open ? 'block' : 'none');
        btn.style.display = open ? 'none' : 'flex';
      } else {
        panel.style.cssText = 'position:fixed;bottom:92px;' + side + ':20px;width:370px;max-width:calc(100vw - 40px);height:560px;max-height:calc(100vh - 120px);border-radius:16px;overflow:hidden;z-index:2147483647;box-shadow:0 24px 64px rgba(16,24,40,.28);background:#fff;display:' + (open ? 'block' : 'none');
        btn.style.display = 'flex';
      }
    }

    var bubble = null;
    function hideGreeting(forGood) {
      if (bubble) { bubble.parentNode && bubble.parentNode.removeChild(bubble); bubble = null; }
      if (forGood) store.set(seenKey, '1');
    }
    function setOpen(v) {
      open = v;
      if (open && !frame.src) frame.src = origin + '/hl/c/' + encodeURIComponent(form) + '?page=' + encodeURIComponent(location.href);
      btn.innerHTML = open ? closeIcon : chatIcon;
      if (open) hideGreeting(true);
      place();
    }
    btn.addEventListener('click', function () { setOpen(!open); });
    // The panel's own close button (it's in the iframe).
    window.addEventListener('message', function (e) {
      if (e.origin === origin && e.data && e.data.hlChat === 'close') setOpen(false);
    });
    window.addEventListener('resize', place);
    place();
    document.body.appendChild(panel);
    document.body.appendChild(btn);

    if (cfg.greeting && !store.get(seenKey)) {
      setTimeout(function () {
        if (open || bubble) return;
        bubble = document.createElement('div');
        bubble.setAttribute('role', 'dialog');
        bubble.style.cssText = 'position:fixed;bottom:92px;' + side + ':20px;max-width:min(300px,calc(100vw - 40px));display:flex;align-items:flex-start;gap:10px;padding:14px 34px 14px 14px;background:#fff;color:#101828;border-radius:14px;box-shadow:0 12px 32px rgba(16,24,40,.22);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;cursor:pointer;z-index:2147483646';
        if (cfg.logo) {
          var img = document.createElement('img');
          img.src = cfg.logo;
          img.alt = cfg.business ? cfg.business + ' logo' : 'Logo';
          img.style.cssText = 'width:36px;height:36px;border-radius:50%;object-fit:contain;background:#fff;flex:none;border:1px solid #EAECF0';
          bubble.appendChild(img);
        }
        var text = document.createElement('span');
        text.textContent = cfg.greeting;
        bubble.appendChild(text);
        var x = document.createElement('button');
        x.type = 'button';
        x.setAttribute('aria-label', 'Close');
        x.innerHTML = '&times;';
        x.style.cssText = 'position:absolute;top:6px;right:8px;border:0;background:none;color:#667085;font-size:20px;line-height:1;cursor:pointer;padding:2px';
        x.addEventListener('click', function (e) { e.stopPropagation(); hideGreeting(true); });
        bubble.appendChild(x);
        bubble.addEventListener('click', function () { setOpen(true); });
        document.body.appendChild(bubble);
      }, 3500);
    }
  }

  function ready(fn) { if (document.body) fn(); else document.addEventListener('DOMContentLoaded', fn); }
  var go = function (cfg) { ready(function () { start(cfg || {}); }); };
  if (window.fetch) fetch(origin + '/api/hl/public/widget/' + encodeURIComponent(form)).then(function (r) { return r.ok ? r.json() : {}; }).then(go, function () { go({}); });
  else go({});
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
