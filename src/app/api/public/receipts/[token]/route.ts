import { NextResponse } from 'next/server'
import { markReceiptOpen, pixelGif } from '@/lib/disputes/receipts'
import { clientIp } from '@/lib/rate-limit'

/** A 1×1 pixel. Mail scanners prefetch these, so an open is supporting evidence. */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  await markReceiptOpen(token, clientIp(req), req.headers.get('user-agent')).catch(() => {})
  const gif = pixelGif()
  const body = new Uint8Array(gif.byteLength)
  body.set(gif)
  return new NextResponse(body, {
    headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' },
  })
}
