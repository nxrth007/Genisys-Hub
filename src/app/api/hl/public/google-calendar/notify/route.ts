import { NextResponse, after } from 'next/server'
import { handleGoogleNotification } from '@/lib/hl/google-sync'

/**
 * POST: Google Calendar's push notification for a watched calendar
 * (src/lib/hl/google-sync.ts). It carries no event, only the channel's id
 * and our token in its headers; Google wants a quick 2xx, so the reading
 * of what changed happens after answering.
 */
export async function POST(req: Request) {
  try {
    const work = await handleGoogleNotification({
      channelId: req.headers.get('x-goog-channel-id'),
      token: req.headers.get('x-goog-channel-token'),
      state: req.headers.get('x-goog-resource-state'),
    })
    if (work) after(() => work().catch((err) => console.error('[hell-level] google calendar sync failed:', err)))
  } catch (err) {
    console.error('[hell-level] google notification failed:', err)
  }
  return new NextResponse(null, { status: 200 })
}
