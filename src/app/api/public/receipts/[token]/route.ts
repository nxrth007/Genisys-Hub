import { NextResponse } from 'next/server'
import { markReceiptOpen, pixelGif } from '@/lib/disputes/receipts'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'

/** A 1×1 pixel. Mail scanners prefetch these, so an open is supporting evidence. */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  const ip = clientIp(req)
  if (checkRateLimit(`receipt-open:${ip}`, 60, 60_000).ok && /^[a-f0-9]{32,128}$/i.test(token)) {
    await markReceiptOpen(token, ip, req.headers.get('user-agent')).catch(() => {})
  }
  const gif = pixelGif()
  const body = new Uint8Array(gif.byteLength)
  body.set(gif)
  return new NextResponse(body, {
    headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' },
  })
}
