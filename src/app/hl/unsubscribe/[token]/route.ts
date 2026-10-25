import { contactFromToken, unsubscribeContact } from '@/lib/hl/email'

type Ctx = { params: Promise<{ token: string }> }

/**
 * /hl/unsubscribe/<token>: the link at the bottom of automation email. GET
 * asks to confirm (link scanners open links, and shouldn't unsubscribe
 * anyone); POST does it, including Gmail's and Yahoo's one-click unsubscribe
 * (List-Unsubscribe-Post), which posts here directly.
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

function page(title: string, body: string, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f4f5f7;color:#1d2939;display:grid;place-items:center;min-height:100vh}
main{background:#fff;border:1px solid #eaecf0;border-radius:16px;padding:32px;max-width:420px;margin:16px;box-shadow:0 8px 24px -12px rgba(16,24,40,.18)}
h1{font-size:19px;margin:0 0 8px}p{margin:0 0 20px;color:#475467}button{font:600 15px/1 inherit;font-family:inherit;background:#101828;color:#fff;border:0;border-radius:10px;padding:12px 18px;cursor:pointer}</style></head>
<body><main>${body}</main></body></html>`
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}

const gone = () => page('Link not valid', '<h1>This link isn’t valid</h1><p>It may have been copied incompletely. Use the unsubscribe link in the email itself.</p>', 404)

export async function GET(_req: Request, { params }: Ctx) {
  const { token } = await params
  if (!contactFromToken(token)) return gone()
  return page('Unsubscribe', `<h1>Unsubscribe from these emails?</h1><p>You won’t get any more email from this business. Texts and calls aren’t affected.</p><form method="post"><button type="submit">Unsubscribe</button></form>`)
}

export async function POST(_req: Request, { params }: Ctx) {
  const { token } = await params
  const contactId = contactFromToken(token)
  if (!contactId) return gone()
  const r = await unsubscribeContact(contactId)
  if (!r) return gone()
  return page('Unsubscribed', `<h1>You’re unsubscribed</h1><p>${esc(r.email ?? 'This address')} won’t get any more email from ${esc(r.business)}.</p>`)
}
