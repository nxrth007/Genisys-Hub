import { NextRequest, NextResponse } from 'next/server'
import { verifyExternalRequest, isOwner, type ExternalAuth } from './external-api'
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

/**
 * Guard for writes behind an admin-only screen.
 *
 * Call at the top of a handler. Nav-level hiding does nothing here — a
 * staff account can post to any endpoint it knows the URL of.
 */
export function requireOwner(auth: WriteContext['auth']): void {
  if (!isOwner(auth)) {
    throw new WriteError('This section is restricted to admins.', 403)
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

    // Parse only when a body was actually sent. DELETE carries its id in
    // the query string and sends nothing, and req.json() throws on an
    // empty payload — which surfaced as "Invalid JSON body" on every
    // delete, before the handler ran. An absent body is valid; a
    // malformed one is not, and only that should fail.
    let body: Record<string, unknown> = {}
    if (req.method !== 'GET') {
      const raw = await req.text().catch(() => '')
      if (raw.trim()) {
        try {
          body = JSON.parse(raw) as Record<string, unknown>
        } catch {
          return fail('Invalid JSON body', 400)
        }
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
