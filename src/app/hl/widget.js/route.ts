/**
 * GET /hl/widget.js: the chat bubble for client websites.
 *
 *   <script src="https://genisys-hub.onrender.com/hl/widget.js" data-form="FORM_ID" async></script>
 *
 * A round button in the business's colour pops in at the corner; a few
 * seconds later a greeting with the business logo slides out beside it, as
 * GHL's does (with a "1" on the button), until the visitor closes it. The button opens the chat panel
 * (served by the Hub at /hl/c/FORM_ID): a card that rises into place, full
 * screen on a phone. The panel is loaded as soon as the visitor shows interest
 * (the greeting, or a hover), so it opens instantly.
 *
 * Plain ES5 with inline styles, so it runs on whatever the client's site is;
 * it waits for the page body and starts once however many times it's included.
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
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var ease = 'cubic-bezier(.2,.8,.2,1)';

  function hexOk(c) { return /^#[0-9a-f]{6}$/i.test(c || ''); }
  function rgb(c) { return [1, 3, 5].map(function (i) { return parseInt(c.slice(i, i + 2), 16) / 255; }); }
  function lum(c) { var v = rgb(c).map(function (x) { return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; }
  function mix(c, t, p) { var a = rgb(c), b = rgb(t); return '#' + a.map(function (x, i) { return ('0' + Math.round((x + (b[i] - x) * p) * 255).toString(16)).slice(-2); }).join(''); }
  function el(tag, css) { var e = document.createElement(tag); if (css) e.style.cssText = css; return e; }

  function start(cfg) {
    var color = hexOk(s.getAttribute('data-color')) ? s.getAttribute('data-color') : hexOk(cfg.color) ? cfg.color : '#155EEF';
    // White on the colour when it reads (3:1), else a deep shade of the colour itself, as the chat panel does.
    var L = lum(color);
    var ink = 1.05 / (L + 0.05) >= 3 || 1.05 / (L + 0.05) >= (L + 0.05) / 0.0603 ? '#FFFFFF' : mix(color, '#000000', 0.78);
    var open = false;
    var font = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';

    // The button: the business's colour, a soft sheen, a lift on hover.
    var btn = el('button', 'position:fixed;bottom:20px;' + side + ':20px;width:62px;height:62px;border-radius:50%;border:0;padding:0;cursor:pointer;z-index:2147483646;display:flex;align-items:center;justify-content:center;color:' + ink + ';background:linear-gradient(145deg,' + mix(color, '#FFFFFF', 0.16) + ' 0%,' + color + ' 55%,' + mix(color, '#000000', 0.12) + ' 100%);box-shadow:0 10px 28px -6px rgba(16,24,40,.38),0 2px 6px rgba(16,24,40,.12),inset 0 1px 0 rgba(255,255,255,.25);transform:scale(.4);opacity:0;transition:' + (still ? 'none' : 'transform .35s ' + ease + ',opacity .25s ease,box-shadow .2s ease'));
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Chat with us');
    var dot = function (x) { return '<circle cx="' + x + '" cy="11" r="1.3" fill="' + color + '"/>'; };
    var chatIcon = '<svg width="30" height="30" viewBox="0 0 24 24"><path d="M5 4h14a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-6.2l-4.3 3.4c-.5.4-1.2 0-1.2-.6V18H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z" fill="currentColor"/>' + dot(8) + dot(12) + dot(16) + '</svg>';
    var downIcon = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
    var face = el('span', 'display:flex;transition:' + (still ? 'none' : 'transform .3s ' + ease + ',opacity .2s ease'));
    face.innerHTML = chatIcon;
    btn.appendChild(face);
    // "1": the greeting is a message waiting; gone once the chat opens or the greeting is closed.
    var badge = el('span', 'position:absolute;top:-3px;right:-3px;min-width:20px;height:20px;padding:0 6px;box-sizing:border-box;border-radius:10px;background:#F04438;color:#fff;font:600 12px/20px ' + font + ';text-align:center;box-shadow:0 0 0 2.5px #fff;transform:scale(0);transition:' + (still ? 'none' : 'transform .3s ' + ease));
    badge.textContent = '1';
    badge.setAttribute('aria-hidden', 'true');
    btn.appendChild(badge);
    btn.addEventListener('mouseenter', function () { if (!still) btn.style.transform = 'translateY(-2px) scale(1.05)'; btn.style.boxShadow = '0 14px 32px -6px rgba(16,24,40,.45),0 3px 8px rgba(16,24,40,.14),inset 0 1px 0 rgba(255,255,255,.25)'; preload(); });
    btn.addEventListener('mouseleave', function () { btn.style.transform = 'none'; btn.style.boxShadow = '0 10px 28px -6px rgba(16,24,40,.38),0 2px 6px rgba(16,24,40,.12),inset 0 1px 0 rgba(255,255,255,.25)'; });

    // The panel: a card that rises into place (the whole screen on a phone).
    var panel = el('div');
    // Until the chat has loaded, a sketch of it: the header in the business's colour with its
    // logo and name, a couple of grey messages. The chat fades in over it, so opening is never blank.
    var sketch = el('div', 'position:absolute;top:0;left:0;right:0;bottom:0;background:#F4F5F7;transition:opacity .3s ease');
    var head = el('div', 'height:92px;box-sizing:border-box;padding:16px;display:flex;align-items:flex-start;gap:12px;background:linear-gradient(135deg,' + mix(color, '#FFFFFF', 0.14) + ' 0%,' + color + ' 46%,' + mix(color, '#000000', 0.16) + ' 100%);color:' + ink + ';font:600 16px/1.25 ' + font);
    if (cfg.logo) {
      var mark = el('img', 'width:48px;height:48px;flex:none;border-radius:50%;background:#fff;object-fit:contain;padding:5px;box-sizing:border-box;box-shadow:0 2px 10px rgba(16,24,40,.2)');
      mark.src = cfg.logo;
      mark.alt = '';
      head.appendChild(mark);
    }
    var who = el('span', 'padding-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis');
    who.textContent = cfg.business || '';
    head.appendChild(who);
    sketch.appendChild(head);
    var lines = el('div', 'margin-top:-13px;border-radius:18px 18px 0 0;background:#F4F5F7;padding:18px 14px 0 52px;display:flex;flex-direction:column;gap:6px');
    [72, 84].forEach(function (w) { lines.appendChild(el('div', 'height:44px;width:' + w + '%;border-radius:18px 18px 18px 6px;background:#fff;border:1px solid #EEF0F3')); });
    lines.appendChild(el('div', 'height:220px;margin:10px 0 0 -38px;border-radius:18px;background:#fff;border:1px solid #EAECF0'));
    sketch.appendChild(lines);
    panel.appendChild(sketch);
    var frame = el('iframe', 'position:absolute;top:0;left:0;width:100%;height:100%;border:0;display:block;background:transparent;opacity:0;transition:opacity .3s ease');
    frame.title = 'Chat with us';
    frame.setAttribute('allow', 'clipboard-write');
    frame.addEventListener('load', function () {
      if (!frame.getAttribute('src')) return; // the empty frame's own load, before the chat is asked for
      frame.style.opacity = '1';
      sketch.style.opacity = '0';
      setTimeout(function () { sketch.style.display = 'none'; }, 320);
    });
    panel.appendChild(frame);
    function preload() { if (!frame.src) frame.src = origin + '/hl/c/' + encodeURIComponent(form) + '?page=' + encodeURIComponent(location.href); }
    var phone = function () { return window.innerWidth < 520; };
    // Full screen on a phone: the page behind stays put while the chat is open.
    var lockedAt = null;
    function lock(v) {
      var h = document.documentElement.style;
      if (v && lockedAt === null) { lockedAt = h.overflow; h.overflow = 'hidden'; }
      else if (!v && lockedAt !== null) { h.overflow = lockedAt; lockedAt = null; }
    }
    function place() {
      var base = 'position:fixed;z-index:2147483647;background:#F4F5F7;overflow:hidden;transition:' + (still ? 'none' : 'opacity .22s ease,transform .32s ' + ease) + ';';
      if (phone()) {
        panel.style.cssText = base + 'top:0;left:0;right:0;bottom:0;width:100%;height:100%;border-radius:0;transform-origin:50% 100%;';
        btn.style.visibility = open ? 'hidden' : 'visible';
      } else {
        panel.style.cssText = base + 'bottom:96px;' + side + ':20px;width:384px;max-width:calc(100vw - 40px);height:640px;max-height:calc(100vh - 116px);border-radius:20px;box-shadow:0 28px 80px -12px rgba(16,24,40,.38),0 6px 20px rgba(16,24,40,.10);transform-origin:' + (side === 'left' ? '0' : '100%') + ' 100%;';
        btn.style.visibility = 'visible';
      }
      lock(open && phone());
      panel.style.display = open ? 'block' : 'none';
      panel.style.opacity = open ? '1' : '0';
      panel.style.transform = open ? 'none' : 'translateY(16px) scale(.97)';
    }

    var bubble = null;
    function hideGreeting(forGood) {
      badge.style.transform = 'scale(0)';
      if (bubble) {
        var b = bubble;
        bubble = null;
        b.style.opacity = '0';
        b.style.transform = 'translateY(6px) scale(.98)';
        setTimeout(function () { b.parentNode && b.parentNode.removeChild(b); }, still ? 0 : 220);
      }
      if (forGood) store.set(seenKey, '1');
    }
    var closing = null;
    function setOpen(v) {
      open = v;
      clearTimeout(closing);
      if (open) {
        preload();
        hideGreeting(true);
        place();
        panel.style.opacity = '0';
        panel.style.transform = 'translateY(16px) scale(.97)';
        requestAnimationFrame(function () { requestAnimationFrame(function () { panel.style.opacity = '1'; panel.style.transform = 'none'; }); });
      } else {
        panel.style.opacity = '0';
        panel.style.transform = 'translateY(16px) scale(.97)';
        closing = setTimeout(place, still ? 0 : 260);
        if (phone()) btn.style.visibility = 'visible';
      }
      // The icon turns into a down arrow (and back) with a small spin.
      if (still) face.innerHTML = open ? downIcon : chatIcon;
      else {
        face.style.opacity = '0';
        face.style.transform = 'scale(.5) rotate(' + (open ? '-90' : '90') + 'deg)';
        setTimeout(function () { face.innerHTML = open ? downIcon : chatIcon; face.style.opacity = '1'; face.style.transform = 'none'; }, 140);
      }
      btn.setAttribute('aria-label', open ? 'Close chat' : 'Chat with us');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    btn.addEventListener('click', function () { setOpen(!open); });
    // The panel's own minimize button lives in the iframe.
    window.addEventListener('message', function (e) {
      if (e.origin === origin && e.data && e.data.hlChat === 'close') setOpen(false);
    });
    document.addEventListener('keydown', function (e) { if (open && e.key === 'Escape') setOpen(false); });
    window.addEventListener('resize', function () { if (open) place(); });
    place();
    document.body.appendChild(panel);
    document.body.appendChild(btn);
    setTimeout(function () { btn.style.opacity = '1'; btn.style.transform = 'none'; }, 350);

    // The greeting: the logo and a line, with a tail pointing at the button.
    if (cfg.greeting && !store.get(seenKey)) {
      setTimeout(function () {
        if (open || bubble) return;
        preload();
        bubble = el('div', 'position:fixed;bottom:98px;' + side + ':20px;width:max-content;max-width:min(304px,calc(100vw - 40px));display:flex;align-items:center;gap:11px;padding:13px 38px 13px 13px;background:#fff;color:#1D2939;border-radius:16px;border:1px solid rgba(16,24,40,.06);box-shadow:0 16px 40px -10px rgba(16,24,40,.30),0 3px 10px rgba(16,24,40,.08);font:400 14.5px/1.45 ' + font + ';cursor:pointer;z-index:2147483646;opacity:0;transform:translateY(8px) scale(.98);transform-origin:' + (side === 'left' ? '0' : '100%') + ' 100%;transition:' + (still ? 'none' : 'opacity .25s ease,transform .35s ' + ease));
        bubble.setAttribute('role', 'dialog');
        bubble.setAttribute('aria-label', 'Message from ' + (cfg.business || 'us'));
        var tail = el('span', 'position:absolute;bottom:-7px;' + side + ':24px;width:14px;height:14px;background:#fff;transform:rotate(45deg);border-right:1px solid rgba(16,24,40,.06);border-bottom:1px solid rgba(16,24,40,.06);border-bottom-right-radius:3px');
        bubble.appendChild(tail);
        if (cfg.logo) {
          var img = el('img', 'width:40px;height:40px;border-radius:50%;object-fit:contain;background:#fff;flex:none;padding:2px;box-sizing:border-box;box-shadow:0 0 0 1px rgba(16,24,40,.08)');
          img.src = cfg.logo;
          img.alt = '';
          bubble.appendChild(img);
        }
        var text = el('span', 'position:relative;display:flex;flex-direction:column;gap:1px;min-width:0');
        if (cfg.business) {
          var who = el('span', 'font:600 13px/1.35 ' + font + ';color:#101828');
          who.textContent = cfg.business;
          text.appendChild(who);
        }
        var line = el('span', 'color:#475467');
        line.textContent = cfg.greeting;
        text.appendChild(line);
        bubble.appendChild(text);
        var x = el('button', 'position:absolute;top:6px;right:6px;width:24px;height:24px;border:0;border-radius:50%;background:transparent;color:#98A2B3;font:400 18px/24px ' + font + ';cursor:pointer;padding:0');
        x.type = 'button';
        x.setAttribute('aria-label', 'Close');
        x.innerHTML = '&times;';
        x.addEventListener('mouseenter', function () { x.style.background = '#F2F4F7'; x.style.color = '#475467'; });
        x.addEventListener('mouseleave', function () { x.style.background = 'transparent'; x.style.color = '#98A2B3'; });
        x.addEventListener('click', function (e) { e.stopPropagation(); hideGreeting(true); });
        bubble.appendChild(x);
        bubble.addEventListener('click', function () { setOpen(true); });
        document.body.appendChild(bubble);
        requestAnimationFrame(function () { requestAnimationFrame(function () { if (bubble) { bubble.style.opacity = '1'; bubble.style.transform = 'none'; badge.style.transform = 'scale(1)'; } }); });
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
