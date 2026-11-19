import { NextResponse } from 'next/server'
import { confirmMilestone } from '@/lib/disputes/receipts'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'

function page(title: string, body: string) {
  return new NextResponse(`<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem">
<h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

/** The email link opens this page. The button is the confirmation, so a mail scanner that only GETs the link does not confirm it. */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  return new NextResponse(`<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem">
<h1 style="font-size:1.25rem">Confirm service started</h1>
<p>Lead Genisys set up lead generation and marketing for your business. Press the button to confirm you received it.</p>
<form method="POST" action="/api/public/acknowledge/${encodeURIComponent(token)}">
<button type="submit" style="background:#111;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-size:15px">Confirm service started</button>
</form></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  const ip = clientIp(req)
  if (!checkRateLimit(`ack:${ip}`, 20, 60_000).ok) return page('Slow down', 'Too many confirmation attempts. Wait a minute and try the link again.')
  if (!/^[a-f0-9]{32,128}$/i.test(token)) return page('Link not found', 'This confirmation link is not valid.')
  const result = await confirmMilestone(token, ip, req.headers.get('user-agent'))
  if (!result.ok) return page('Link not found', 'This confirmation link is not valid.')
  return page('Recorded', result.already ? 'You already confirmed this. Thank you.' : 'Thank you. We recorded that service has started, with the time and the network address of this confirmation.')
}
