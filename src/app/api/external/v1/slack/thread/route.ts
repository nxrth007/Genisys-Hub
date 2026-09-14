import { NextRequest } from 'next/server'
import { withOwnerApi, externalOptions } from '@/lib/external-api'
import { getThreadReplies } from '@/lib/slack'

/** GET ?channelId=&ts= — replies in a thread, parent excluded. */
export const GET = withOwnerApi(async (req) => {
  const channelId = (req.nextUrl.searchParams.get('channelId') ?? '').trim()
  const ts = (req.nextUrl.searchParams.get('ts') ?? '').trim()
  if (!channelId || !ts) {
    return { error: 'channelId and ts are required', replies: [] }
  }

  try {
    return { replies: await getThreadReplies(channelId, ts) }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Could not read the thread.',
      replies: [],
    }
  }
})

export function OPTIONS(req: NextRequest) {
  return externalOptions(req)
}
