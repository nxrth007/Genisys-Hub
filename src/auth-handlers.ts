// Re-export handlers so the catch-all route keeps a minimal footprint.
// The request's IP and user agent stay available to the sign-in event,
// which is how a dashboard login is written onto the dispute ledger.
import { NextRequest } from 'next/server'
import { handlers } from '@/auth'
import { clientIp } from '@/lib/rate-limit'
import { requestContext } from '@/lib/request-context'

function wrap(handler: (req: NextRequest) => Promise<Response>) {
  return (req: NextRequest) =>
    requestContext.run({ ip: clientIp(req), userAgent: req.headers.get('user-agent') }, () => handler(req))
}

export const GET = wrap(handlers.GET)
export const POST = wrap(handlers.POST)
