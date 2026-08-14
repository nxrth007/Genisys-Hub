import { NextRequest, NextResponse } from 'next/server'
import { verifyExternalRequest, type ExternalAuth } from './external-api'
import { withCors } from './external-cors'

/**
 * Wrapper for write endpoints on the external API.
 *
 * withExternalApi() is GET-shaped: it collapses any thrown error into a
 * generic 500, which is fine when the caller only wanted data and wrong
 * when they changed something and need to know what happened.
 *
 * Writes also carry a stricter auth rule than reads: they require a
 * signed-in account. The shared environment token has no person behind
 * it, can't be revoked without a redeploy, and would leave changes
 * unattributable — fine for reading a dashboard, not for editing records.
 */

export type WriteContext = {
  auth: ExternalAuth & { user: NonNullable<ExternalAuth['user']> }
  body: Record<string, unknown>
}

/** Thrown by a handler to return a specific status instead of a 500. */
export class WriteError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export function externalWrite(
  handler: (ctx: WriteContext, req: NextRequest) => Promise<unknown>,
) {
  return async function route(req: NextRequest): Promise<NextResponse> {
    const origin = req.headers.get('origin')
    const fail = (message: string, status: number) =>
      withCors(NextResponse.json({ error: message }, { status }), origin)

    const auth = await verifyExternalRequest(req)
    if (!auth) return fail('Missing or invalid API token.', 401)
    if (!auth.user) {
      return fail(
        'This action requires a signed-in account. The shared environment token cannot modify records.',
        403,
      )
    }

    let body: Record<string, unknown> = {}
    if (req.method !== 'GET') {
      try {
        body = await req.json()
      } catch {
        return fail('Invalid JSON body', 400)
      }
    }

    try {
      const data = await handler(
        { auth: auth as WriteContext['auth'], body },
        req,
      )
      return withCors(NextResponse.json({ ok: true, data }), origin)
    } catch (err) {
      if (err instanceof WriteError) {
        return fail(err.message, err.status)
      }
      console.error('[external-write]', req.nextUrl.pathname, err)
      return fail(
        err instanceof Error ? err.message : 'Something went wrong.',
        500,
      )
    }
  }
}
