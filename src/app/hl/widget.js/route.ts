/**
 * GET /hl/widget.js: the chat bubble for client websites.
 *
 *   <script src="https://genisys-hub.onrender.com/hl/widget.js" data-form="FORM_ID" async></script>
 *
 * Adds a round button in the corner; clicking it opens the chat widget form
 * (served by the Hub at /hl/c/FORM_ID) in a small panel.
 */
const SCRIPT = `(function () {
  var s = document.currentScript || document.querySelector('script[data-form][src*="/hl/widget.js"]');
  if (!s || window.__hlWidget) return;
  window.__hlWidget = true;
  var form = s.getAttribute('data-form');
  if (!form) return;
  var origin = new URL(s.src).origin;
  var color = s.getAttribute('data-color') || '#155EEF';
  var side = s.getAttribute('data-position') === 'left' ? 'left' : 'right';
  var open = false;
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Chat with us');
  btn.style.cssText = 'position:fixed;bottom:20px;' + side + ':20px;width:60px;height:60px;border-radius:50%;border:0;cursor:pointer;z-index:2147483646;box-shadow:0 8px 24px rgba(16,24,40,.25);display:flex;align-items:center;justify-content:center;background:' + color;
  var chatIcon = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var closeIcon = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  btn.innerHTML = chatIcon;
  var panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;bottom:92px;' + side + ':20px;width:370px;max-width:calc(100vw - 40px);height:560px;max-height:calc(100vh - 120px);border-radius:16px;overflow:hidden;z-index:2147483647;box-shadow:0 24px 64px rgba(16,24,40,.28);display:none;background:#fff';
  var frame = document.createElement('iframe');
  frame.title = 'Chat with us';
  frame.style.cssText = 'width:100%;height:100%;border:0';
  panel.appendChild(frame);
  btn.addEventListener('click', function () {
    open = !open;
    if (open && !frame.src) frame.src = origin + '/hl/c/' + encodeURIComponent(form) + '?page=' + encodeURIComponent(location.href);
    panel.style.display = open ? 'block' : 'none';
    btn.innerHTML = open ? closeIcon : chatIcon;
  });
  document.body.appendChild(panel);
  document.body.appendChild(btn);
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
