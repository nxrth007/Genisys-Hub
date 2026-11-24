import { NextResponse } from 'next/server'
import { noteWorkEmbedSeen, workFeed } from '@/lib/hl/work-photos'

type Ctx = { params: Promise<{ accountId: string }> }

const HEADERS = { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=60' }

/** GET: a client's Recent Work feed for their website's script (/hl/work.js). A request from a website is noted: that site shows the feed. */
export async function GET(req: Request, { params }: Ctx) {
  const { accountId } = await params
  if (!/^[a-z0-9]{10,40}$/i.test(accountId)) return NextResponse.json({ error: 'No such feed.' }, { status: 404, headers: HEADERS })
  const feed = await workFeed(accountId)
  if (!feed) return NextResponse.json({ error: 'No such feed.' }, { status: 404, headers: HEADERS })
  const from = req.headers.get('origin') || req.headers.get('referer') || ''
  try {
    if (from) await noteWorkEmbedSeen(accountId, new URL(from).hostname)
  } catch {
    // not a web address: nothing to note
  }
  return NextResponse.json(feed, { headers: HEADERS })
}
